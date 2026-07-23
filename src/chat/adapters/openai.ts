/**
 * OpenAI adapter — uses OpenAI's Responses API with the MCP tool type.
 *
 * OpenAI's Responses API supports MCP servers natively (since Feb 2025).
 * Pattern is symmetrical to the Claude adapter — pass the MCP server URL
 * + SF access token, OpenAI handles the entire MCP round-trip internally.
 *
 * We use fetch directly (not the SDK) because the MCP tool type is still
 * being surfaced in the TypeScript client — cleaner to speak the JSON API
 * directly and stay future-proof.
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

const OPENAI_URL = 'https://api.openai.com/v1/responses';

interface OpenAiResponsesResult {
  id:     string;
  model:  string;
  output: Array<{
    type:    string;
    id?:     string;
    role?:   string;
    content?: Array<{ type: string; text?: string }>;
    // MCP tool call/result blocks
    name?:   string;
    server_label?: string;
    arguments?: unknown;
    output?:    unknown;
    error?:     unknown;
  }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export async function runOpenAiAdapter(
  req: ChatTurnRequest,
  aiNode: AgentNode,
): Promise<ChatTurnResult> {
  // Resolve credentials: per-user override from Apex → fall back to .env
  const creds = resolveEngine('openai', req.engineOverride);
  const apiKey = creds.apiKey;

  const install = await InstallsRepo.findByOrgId(req.context.orgId);
  if (!install?.sfAccessToken) {
    throw new Error('Org has no Salesforce tokens. Admin must run Synapse Setup first.');
  }

  const model        = creds.defaultModel || (aiNode.config as { model?: string })?.model || 'gpt-4o';
  const systemPrompt = await buildSystemPrompt(req.agent, aiNode, req.context, req.newUserMessage, req.engineOverride);
  // Attachments are opt-in — skip the whole helper (no jsforce, no SF calls)
  // when the turn has none.
  const attachments = (req.attachments && req.attachments.length > 0)
    ? await loadAttachments(req.context.orgId, req.attachments)
    : [];
  const input = mapHistoryForOpenAi(req.history, req.newUserMessage, systemPrompt, attachments);

  // Multi-connector: Salesforce sends connectors[] each turn; we attach the
  // right token per provider. Legacy fallback = single env-configured SF MCP.
  // OpenAI enforces allowed_tools HARD — unticked tools are invisible to the model.
  const servers = await resolveMcpServers(req, aiNode, install.sfAccessToken);
  if (servers.length === 0) {
    throw new Error('No MCP servers available for this agent. Bind a connector on the canvas, or set SF_REMOTE_MCP_URL.');
  }

  const tools = servers.map(s => {
    const mcpTool: Record<string, unknown> = {
      type:             'mcp',
      server_label:     s.name,
      server_url:       s.url,
      headers:          { Authorization: 'Bearer ' + s.token },
      require_approval: 'never',
    };
    if (s.allowedTools.length > 0) mcpTool.allowed_tools = s.allowedTools;
    return mcpTool;
  });

  const body = {
    model,
    input,
    tools,
    max_output_tokens: 8_000,
  };

  logger.info({
    orgId: req.context.orgId,
    model,
    historyLen: input.length,
    mcpServerCount: servers.length,
    mcpServers: servers.map(s => ({ name: s.name, allowedToolCount: s.allowedTools.length })),
  }, 'openai_adapter_request');

  const t0 = Date.now();
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as OpenAiResponsesResult;

  if (!res.ok || json.error) {
    logger.error({ status: res.status, err: json.error }, 'openai_adapter_error');
    throw new Error(json.error?.message ?? `OpenAI API error ${res.status}`);
  }

  logger.info({
    orgId: req.context.orgId,
    tokensIn: json.usage?.input_tokens,
    tokensOut: json.usage?.output_tokens,
    ms: Date.now() - t0,
  }, 'openai_adapter_response');

  // Preferred: use the flattened output_text field OpenAI provides
  let assistantText = json.output_text?.trim() ?? '';
  if (!assistantText) {
    // Fallback — walk output blocks and collect any text content
    for (const b of json.output ?? []) {
      if (b.type === 'message' && Array.isArray(b.content)) {
        for (const c of b.content) if (typeof c.text === 'string') assistantText += c.text;
      }
    }
    assistantText = assistantText.trim();
  }

  const toolCalls: ToolCallSummary[] = [];
  for (const b of json.output ?? []) {
    if (b.type === 'mcp_call' || b.type === 'mcp_tool_call') {
      // Failed MCP calls carry `error` and a null output — surface the error
      // text so the transcript shows WHY instead of a bare "null".
      const failed = !!b.error;
      toolCalls.push({
        id:      b.id ?? '',
        name:    b.name ?? '',
        input:   (b.arguments as Record<string, unknown>) ?? {},
        output:  failed ? `MCP call failed: ${typeof b.error === 'string' ? b.error : JSON.stringify(b.error)}` : b.output,
        isError: failed,
      });
      if (failed) {
        logger.warn({ tool: b.name, error: b.error }, 'openai_mcp_call_failed');
      }
    }
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

/** Map our history + system prompt + new user message (+ attachments) → OpenAI Responses `input` array. */
function mapHistoryForOpenAi(
  history: ChatHistoryMessage[],
  newUserMessage: string,
  systemPrompt: string,
  attachments: LoadedAttachment[] = [],
): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  const out: Array<{ role: string; content: Array<Record<string, unknown>> }> = [];
  out.push({ role: 'system', content: [{ type: 'input_text', text: systemPrompt }] });
  for (const m of history) {
    if (m.role === 'system' || m.role === 'tool') continue;
    out.push({
      role: m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
    });
  }

  // Build the final user message with attachments as extra content parts.
  const finalContent: Array<Record<string, unknown>> = [];
  if (newUserMessage && newUserMessage.trim().length > 0) {
    finalContent.push({ type: 'input_text', text: newUserMessage });
  }
  for (const att of attachments) {
    if (att.kind === 'image') {
      finalContent.push({
        type:      'input_image',
        image_url: `data:${att.mimeType};base64,${att.base64}`,
      });
    } else if (att.kind === 'pdf') {
      finalContent.push({
        type:      'input_file',
        filename:  att.fileName,
        file_data: `data:application/pdf;base64,${att.base64}`,
      });
    } else if (att.kind === 'text') {
      const decoded = Buffer.from(att.base64, 'base64').toString('utf8');
      finalContent.push({
        type: 'input_text',
        text: `[Attached file: ${att.fileName}]\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else {
      finalContent.push({
        type: 'input_text',
        text: `[Attached file: ${att.fileName} — unsupported type, skipped]`,
      });
    }
  }
  if (finalContent.length === 0) {
    finalContent.push({ type: 'input_text', text: '(no message)' });
  }
  out.push({ role: 'user', content: finalContent });
  return out;
}
