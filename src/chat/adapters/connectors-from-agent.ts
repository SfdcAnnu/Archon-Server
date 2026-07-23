/**
 * Server-side equivalent of AgentChatController.buildConnectorsPayload —
 * flow runs have no per-turn Apex round trip to attach connectors[], so we
 * build the same shape here from the agent definition already in memory
 * plus one SOQL for ConnectorCatalog__mdt (custom metadata, safe to read
 * with the org's own connection).
 */
import type { Connection } from 'jsforce';
import type { AgentDefinition } from '../../types';
import type { ConnectorInput } from './types';

export async function buildConnectorInputsFromAgent(
  agent: AgentDefinition,
  conn: Connection,
): Promise<ConnectorInput[]> {
  const catalogNodes = agent.nodes.filter(n => n.nodeType === 'catalog' && n.isEnabled);
  if (catalogNodes.length === 0) return [];

  const res = await conn.query<{ DeveloperName: string; McpServerUrl__c?: string }>(
    'SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt',
  );
  const urlByProvider = new Map<string, string>();
  for (const row of res.records) {
    if (row.McpServerUrl__c) urlByProvider.set(row.DeveloperName, row.McpServerUrl__c.replace(/\/+$/, ''));
  }

  const out: ConnectorInput[] = [];
  for (const n of catalogNodes) {
    const cfg = n.config ?? {};
    const provider = cfg.provider as string | undefined;
    if (!provider || !urlByProvider.has(provider)) continue;

    const allowedTools = Array.isArray(cfg.allowedTools) ? (cfg.allowedTools as string[]) : [];
    const customToolsRaw = Array.isArray(cfg.customTools)
      ? (cfg.customTools as Array<{ type: string; name: string; label?: string }>)
      : [];

    out.push({
      provider,
      mcpServerUrl: urlByProvider.get(provider)!,
      allowedTools,
      connectorId: (cfg.connectorId as string) || null,
      accessMode: provider === 'salesforce_mcp' ? (agent.accessMode ?? 'Org') : null,
      customTools: customToolsRaw.length > 0 ? customToolsRaw : null,
    });
  }
  return out;
}
