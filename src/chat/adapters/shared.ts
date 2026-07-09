/**
 * Shared helpers used by all chat adapters (Claude, OpenAI, later Gemini).
 *
 *   discoverAllowedTools — walks the agent graph, finds the connector node
 *                          downstream of the AI node, returns its
 *                          allowedTools list.
 *   buildSystemPrompt    — assembles the system message from the agent's
 *                          knowledgeBase + the AI node's systemPrompt +
 *                          record context.
 */
import { config } from '../../config';
import { logger } from '../../logger';
import { ConnectorsRepo } from '../../db/connectors.repo';
import { refreshGoogleToken } from '../../oauth/google';
import type { AgentDefinition, AgentNode } from '../../types';
import type { ChatTurnRequest } from './types';
import type { Connector } from '@prisma/client';

/**
 * Return a FRESH access token for a connector row, refreshing when the
 * stored one is expired/near expiry. Google tokens live ~1 hour.
 */
async function freshConnectorToken(row: Connector): Promise<string | null> {
  const SKEW_MS = 60_000;
  const stale = !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() - Date.now() < SKEW_MS;
  if (!stale || !row.refreshToken) return row.accessToken ?? null;

  try {
    if (row.providerKey === 'gmail') {
      const tok = await refreshGoogleToken(row.refreshToken);
      const updated = await ConnectorsRepo.updateTokens(row.id, {
        accessToken:    tok.access_token,
        tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
      });
      logger.info({ connectorId: row.id, provider: row.providerKey }, 'connector_token_refreshed');
      return updated.accessToken;
    }
    return row.accessToken ?? null;   // other providers: use as-is until wired
  } catch (err) {
    logger.error({ err, connectorId: row.id, provider: row.providerKey }, 'connector_token_refresh_failed');
    return row.accessToken ?? null;   // let the MCP call surface the auth error
  }
}

// ── Multi-connector MCP server resolution ──────────────────────────
// Salesforce sends connectors[] each turn (provider, mcpServerUrl,
// allowedTools, connectorId). We attach the right token per provider:
//   • salesforce_mcp → the org's SF access token (OrgInstall)
//   • anything else  → the Connector row's token (Node-side DB)
// When connectors[] is absent (older Apex), fall back to the single
// env-configured Salesforce MCP server.

export interface ResolvedMcpServer {
  name:         string;      // unique server label for the LLM config
  url:          string;      // full .../mcp URL
  token:        string;      // bearer for that MCP server
  allowedTools: string[];    // empty = expose all tools
}

// ── allowedTools sanitization ───────────────────────────────────────
// Agents saved before the live-catalog change carry STALE tool names
// (list_sobjects, get_record, …). OpenAI enforces allowed_tools hard, so a
// zero-overlap list would hide EVERY tool from the model. We validate the
// selection against the server's public /tools catalog (cached 10 min):
//   • partial overlap → keep only the valid names
//   • zero overlap    → treat as legacy garbage: expose ALL tools + warn
//   • catalog fetch fails → pass through unchanged (can't judge)

const toolCatalogCache = new Map<string, { names: Set<string> | null; fetchedAt: number }>();
const CATALOG_TTL_MS = 10 * 60 * 1000;

async function fetchToolNames(baseUrl: string): Promise<Set<string> | null> {
  const cached = toolCatalogCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.names;
  let names: Set<string> | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(`${baseUrl}/tools`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const json = (await res.json()) as { tools?: Array<{ name?: string }> };
      names = new Set((json.tools ?? []).map(t => t.name).filter(Boolean) as string[]);
    }
  } catch { /* unreachable or no /tools — leave null */ }
  toolCatalogCache.set(baseUrl, { names, fetchedAt: Date.now() });
  return names;
}

async function sanitizeAllowedTools(baseUrl: string, allowedTools: string[]): Promise<string[]> {
  if (!allowedTools || allowedTools.length === 0) return [];
  const names = await fetchToolNames(baseUrl);
  if (!names || names.size === 0) return allowedTools;   // can't validate
  const valid = allowedTools.filter(t => names.has(t));
  if (valid.length === 0) {
    logger.warn({ baseUrl, staleTools: allowedTools },
      'allowed_tools_all_stale_exposing_all — re-save the agent to pick fresh tool names');
    return [];
  }
  if (valid.length < allowedTools.length) {
    logger.warn({ baseUrl, dropped: allowedTools.filter(t => !names.has(t)) },
      'allowed_tools_partially_stale');
  }
  return valid;
}

export async function resolveMcpServers(
  req: ChatTurnRequest,
  aiNode: AgentNode,
  sfAccessToken: string,
): Promise<ResolvedMcpServer[]> {
  const out: ResolvedMcpServer[] = [];

  if (req.connectors && req.connectors.length > 0) {
    const seen = new Set<string>();
    for (const c of req.connectors) {
      const base = c.mcpServerUrl.replace(/\/+$/, '');
      let name = c.provider.replace(/[^a-zA-Z0-9_-]/g, '_');
      while (seen.has(name)) name = `${name}_2`;
      seen.add(name);

      let token: string | null = null;
      if (c.provider === 'salesforce_mcp') {
        token = sfAccessToken;
      } else if (c.connectorId) {
        const row = await ConnectorsRepo.getById(req.context.orgId, c.connectorId).catch(() => null);
        token = row ? await freshConnectorToken(row) : null;
      }
      if (!token) {
        logger.warn({ provider: c.provider, orgId: req.context.orgId },
          'mcp_connector_skipped_no_token');
        continue;
      }
      const allowedTools = await sanitizeAllowedTools(base, c.allowedTools ?? []);
      out.push({ name, url: `${base}/mcp`, token, allowedTools });
    }
    return out;
  }

  // Legacy fallback — single Salesforce MCP from env
  if (config.salesforce.remoteMcpUrl) {
    const base = config.salesforce.remoteMcpUrl.replace(/\/+$/, '');
    const { allowedTools } = discoverAllowedTools(req.agent, aiNode);
    out.push({
      name:  'salesforce',
      url:   `${base}/mcp`,
      token: sfAccessToken,
      allowedTools: await sanitizeAllowedTools(base, allowedTools),
    });
  }
  return out;
}

export function discoverAllowedTools(
  agent: AgentDefinition,
  aiNode: AgentNode,
): { allowedTools: string[]; catalogFound: boolean } {
  // Walk canvas connections downstream of the AI node
  const canvas = agent.canvasJson as { connections?: Array<{ fromIndex?: number; toIndex?: number }> } | undefined;
  const connections = canvas?.connections ?? [];

  const downstreamCatalog = agent.nodes.find(n =>
    n.nodeType === 'catalog' &&
    connections.some(c => {
      const from = agent.nodes[c.fromIndex ?? -1]?.id;
      const to   = agent.nodes[c.toIndex   ?? -1]?.id;
      return from === aiNode.id && to === n.id;
    }),
  );

  if (!downstreamCatalog) return { allowedTools: [], catalogFound: false };

  const cfg = downstreamCatalog.config ?? {};
  const allowedTools = Array.isArray(cfg.allowedTools) ? (cfg.allowedTools as string[]) : [];
  return { allowedTools, catalogFound: true };
}

export function buildSystemPrompt(
  agent: AgentDefinition,
  aiNode: AgentNode,
  ctx:   ChatTurnRequest['context'],
): string {
  const config = (aiNode.config as { systemPrompt?: string }) ?? {};
  const parts: string[] = [];

  parts.push(`You are ${agent.name}, a Salesforce-embedded AI agent in chat mode.`);

  if (agent.knowledgeBase && agent.knowledgeBase.trim().length > 0) {
    parts.push('KNOWLEDGE BASE:\n' + agent.knowledgeBase);
  }
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    parts.push(config.systemPrompt);
  }
  if (ctx.recordContextId) {
    parts.push(
      `The user is viewing the ${ctx.recordContextType ?? 'record'} with Id ${ctx.recordContextId}. ` +
      `You may reference it when calling tools.`,
    );
  }
  parts.push(
    'You have access to Salesforce tools through a Model Context Protocol server. ' +
    'Use them to look up records, run SOQL, or take actions when the user asks. Be concise.',
  );
  return parts.join('\n\n');
}
