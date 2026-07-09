/**
 * Claude adapter — uses Anthropic's Managed MCP.
 *
 * We just point the Messages API at the MCP server URL + pass the SF
 * access_token. Anthropic handles the entire MCP protocol: session
 * initialization, tools/list, tools/call, feeding results back to itself,
 * final assistant text.
 *
 * We don't manage tool loops or JSON-RPC sessions. The `mcp_servers` field
 * in the request body is doing all the work.
 *
 * Mirrors the pattern in `MCP with claude example/server.js`.
 */

import { logger } from '../../logger';
import type { AgentNode } from '../../types';
import { InstallsRepo } from '../../db/installs.repo';
import { buildSystemPrompt, resolveMcpServers } from './shared';
import { loadAttachments, type LoadedAttachment } from './attachments';
import { resolveEngine } from '../engine-resolver';
import type {
  ChatHistoryMessage,
  ChatTurnRequest,
  ChatTurnResult,
  ToolCallSummary,
} from './types';

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA    = 'mcp-client-2025-11-20';

/** Minimum shape of blocks in Anthropic message content. */
interface AnthropicBlock {
  type:              string;
  text?:             string;
  id?:               string;
  name?:             string;
  server_name?:      string;
  input?:            Record<string, unknown>;
  tool_use_id?:      string;
  content?:          Array<{ type: string; text?: string }>;
  is_error?:         boolean;
}

interface AnthropicResponse {
  id:      string;
  type:    string;
  role:    'assistant';
  model:   string;
  content: AnthropicBlock[];
  usage?:  { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?:  { type: string; message: string };
}

export async function runClaudeAdapter(
  req: ChatTurnRequest,
  aiNode: AgentNode,
): Promise<ChatTurnResult> {
  // Resolve credentials: per-user override from Apex → fall back to .env
  const creds = resolveEngine('claude', req.engineOverride);
  const apiKey = creds.apiKey;

  const install = await InstallsRepo.findByOrgId(req.context.orgId);
  if (!install?.sfAccessToken) {
    throw new Error('Org has no Salesforce tokens. Admin must run Synapse Setup first.');
  }

  const model         = creds.defaultModel || (aiNode.config as { model?: string })?.model || 'claude-sonnet-4-6';
  const systemPrompt  = buildSystemPrompt(req.agent, aiNode, req.context);
  // Attachments are opt-in. When the turn has none, we make ZERO Salesforce
  // calls, ZERO jsforce init, ZERO extra latency — the adapter goes straight
  // to Anthropic.
  const attachments = (req.attachments && req.attachments.length > 0)
    ? await loadAttachments(req.context.orgId, req.attachments)
    : [];
  const messages = mapHistoryForClaude(req.history, req.newUserMessage, attachments);

  // Multi-connector: Salesforce sends connectors[] each turn; we attach the
  // right token per provider. Legacy fallback = single env-configured SF MCP.
  const servers = await resolveMcpServers(req, aiNode, install.sfAccessToken);
  if (servers.length === 0) {
    throw new Error('No MCP servers available for this agent. Bind a connector on the canvas, or set SF_REMOTE_MCP_URL.');
  }

  const mcpServers = servers.map(s => ({
    type: 'url',
    url:  s.url,
    name: s.name,
    authorization_token: s.token,
  }));
  const toolsets = servers.map(s => ({ type: 'mcp_toolset', mcp_server_name: s.name }));

  // The mcp-client-2025-11-20 beta currently rejects both `tool_configuration`
  // on the server entry and `allowed_tools` on the toolset, so hard tool
  // filtering isn't possible for Claude yet. We enforce softly through the
  // system prompt and log so it's visible.
  const restricted = servers.filter(s => s.allowedTools.length > 0);
  let restrictionPrompt = '';
  if (restricted.length > 0) {
    restrictionPrompt = '\n\nTOOL RESTRICTIONS (enforced policy — never call tools outside these lists):' +
      restricted.map(s => `\n• ${s.name}: only ${s.allowedTools.join(', ')}`).join('');
    logger.warn({
      servers: restricted.map(s => ({ name: s.name, allowedToolCount: s.allowedTools.length })),
    }, 'claude_adapter_allowed_tools_soft_enforced');
  }

  const body = {
    model,
    max_tokens: 8_000,
    system:     systemPrompt + restrictionPrompt,
    messages,
    mcp_servers: mcpServers,
    tools:       toolsets,
  };

  logger.info({
    orgId: req.context.orgId,
    model,
    historyLen: messages.length,
    mcpServerCount: servers.length,
    mcpServers: servers.map(s => s.name),
  }, 'claude_adapter_request');

  const t0 = Date.now();
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta':    ANTHROPIC_BETA,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as AnthropicResponse;

  if (!res.ok || json.error) {
    logger.error({ status: res.status, err: json.error }, 'claude_adapter_error');
    throw new Error(json.error?.message ?? `Anthropic API error ${res.status}`);
  }

  logger.info({
    orgId: req.context.orgId,
    tokensIn: json.usage?.input_tokens,
    tokensOut: json.usage?.output_tokens,
    ms: Date.now() - t0,
  }, 'claude_adapter_response');

  // Extract final assistant text + tool call summaries
  const assistantText = (json.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();

  const toolCalls: ToolCallSummary[] = [];
  const toolUses    = (json.content ?? []).filter(b => b.type === 'mcp_tool_use');
  const toolResults = (json.content ?? []).filter(b => b.type === 'mcp_tool_result');
  for (const use of toolUses) {
    const result = toolResults.find(r => r.tool_use_id === use.id);
    let resultText = '';
    if (result?.content && result.content.length > 0) {
      resultText = result.content[0].text ?? '';
    }
    toolCalls.push({
      id:    use.id ?? '',
      name:  use.name ?? '',
      input: use.input ?? {},
      output: resultText,
      isError: result?.is_error ?? false,
    });
  }

  return {
    status: 'complete',
    assistantText,
    toolCalls,
    modelUsed: model,
    tokensIn:  json.usage?.input_tokens ?? 0,
    tokensOut: json.usage?.output_tokens ?? 0,
  };
}

/** Convert our history + new user message (+ attachments) to Anthropic's messages array. */
function mapHistoryForClaude(
  history: ChatHistoryMessage[],
  newUserMessage: string,
  attachments: LoadedAttachment[] = [],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content });
      continue;
    }
    // tool-role messages are absorbed as continuation blocks in the prior assistant turn.
  }

  // Build the new user message. If there are attachments, use content blocks;
  // otherwise stay with the plain string form Claude prefers.
  if (attachments.length === 0) {
    out.push({ role: 'user', content: newUserMessage });
    return out;
  }

  const blocks: Array<Record<string, unknown>> = [];
  if (newUserMessage && newUserMessage.trim().length > 0) {
    blocks.push({ type: 'text', text: newUserMessage });
  }
  for (const att of attachments) {
    if (att.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.mimeType, data: att.base64 },
      });
    } else if (att.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: att.base64 },
        title: att.fileName,
      });
    } else if (att.kind === 'text') {
      // Decode and inline as text — cheaper than shipping as a document.
      const decoded = Buffer.from(att.base64, 'base64').toString('utf8');
      blocks.push({
        type: 'text',
        text: `[Attached file: ${att.fileName}]\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else {
      blocks.push({
        type: 'text',
        text: `[Attached file: ${att.fileName} — unsupported type, skipped]`,
      });
    }
  }
  // Claude requires at least one block; guarantee text presence.
  if (blocks.length === 0 || !blocks.some(b => b.type === 'text' || b.type === 'image' || b.type === 'document')) {
    blocks.push({ type: 'text', text: newUserMessage || '(no message)' });
  }
  out.push({ role: 'user', content: blocks });
  return out;
}
