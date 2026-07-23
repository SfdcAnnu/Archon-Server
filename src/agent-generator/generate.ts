/**
 * Orchestrates AI agent generation: builds the prompt from spec.ts, calls
 * Claude with two tools (ask a clarifying question, or commit to a graph),
 * validates the result against the same structural rules the engine itself
 * enforces at runtime, and repairs once on failure before giving up.
 */
import Anthropic from '@anthropic-ai/sdk';
import { resolveEngine } from '../chat/engine-resolver';
import type { EngineOverride } from '../chat/engine-resolver';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { ConnectorsRepo } from '../db/connectors.repo';
import { buildSystemPrompt } from './spec';
import { logger } from '../logger';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;
/** At most one clarifying-question round-trip (up to 2 questions in it) before generation is forced. */
export const MAX_QA_ROUNDS = 1;

export interface QaTurn { question: string; answer: string; }

export interface GenerateRequest {
  orgId: string;
  requirementText: string;
  qaHistory?: QaTurn[];
}

export interface GeneratedNode {
  label: string;
  type: string;
  subType: string;
  config: Record<string, unknown>;
  rationale?: string;
  x?: number;
  y?: number;
}
export interface GeneratedConnection { fromIndex: number; fromPort: string; toIndex: number; toPort: string; }
export interface ChecklistItem { title: string; description: string; category: string; }
export interface GeneratedAgentPayload {
  agent: { name: string; department: string; description: string; knowledgeBase: string };
  nodes: GeneratedNode[];
  connections: GeneratedConnection[];
  setupChecklist: ChecklistItem[];
}

export type GenerateResult =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'agent'; agent: GeneratedAgentPayload };

const ASK_TOOL: Anthropic.Messages.Tool = {
  name: 'ask_clarifying_questions',
  description: 'Ask the user 1-2 short, specific questions ONLY when the requirement is genuinely too ambiguous to build a sensible agent. Prefer a reasonable default + a checklist note over asking, whenever possible.',
  input_schema: {
    type: 'object',
    properties: {
      questions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    },
    required: ['questions'],
  },
};

const CREATE_TOOL: Anthropic.Messages.Tool = {
  name: 'create_agent',
  description: 'Create a complete Archon agent graph from the requirement.',
  input_schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          department: { type: 'string', description: 'Best-guess business department, e.g. Sales, Support, Marketing.' },
          description: { type: 'string' },
          knowledgeBase: { type: 'string', description: 'Short plain-English business rules explicitly stated in the requirement. Empty string if none.' },
        },
        required: ['name', 'department', 'description', 'knowledgeBase'],
      },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            type: { type: 'string' },
            subType: { type: 'string' },
            config: { type: 'object' },
            rationale: { type: 'string', description: 'Only set for nodes added proactively, not explicitly requested.' },
          },
          required: ['label', 'type', 'subType', 'config'],
        },
      },
      connections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fromIndex: { type: 'integer' },
            fromPort: { type: 'string' },
            toIndex: { type: 'integer' },
            toPort: { type: 'string' },
          },
          required: ['fromIndex', 'fromPort', 'toIndex', 'toPort'],
        },
      },
      setupChecklist: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string', enum: ['connector', 'ai_engine', 'review', 'knowledge_base', 'other'] },
          },
          required: ['title', 'description', 'category'],
        },
      },
    },
    required: ['agent', 'nodes', 'connections', 'setupChecklist'],
  },
};

export async function generateAgent(req: GenerateRequest, engineOverride?: EngineOverride | null): Promise<GenerateResult> {
  const creds = resolveEngine('claude', engineOverride);
  const client = new Anthropic({ apiKey: creds.apiKey });

  const providerStatus = await fetchProviderStatus(req.orgId).catch((err) => {
    logger.warn({ err, orgId: req.orgId }, 'agent_generate_provider_status_failed');
    return [];
  });
  const systemPrompt = buildSystemPrompt(providerStatus);
  const userMessage = buildUserMessage(req);
  // Exactly one clarification round-trip, regardless of how many questions
  // are in it (the tool itself caps a single call at 2 questions) — once
  // the user has answered anything, generation is forced on this call.
  const canStillAsk = !req.qaHistory || req.qaHistory.length === 0;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    tools: canStillAsk ? [ASK_TOOL, CREATE_TOOL] : [CREATE_TOOL],
    tool_choice: canStillAsk ? { type: 'any' } : { type: 'tool', name: 'create_agent' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolUse = response.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error('The model did not return a usable response. Try rephrasing the requirement.');
  }

  if (toolUse.name === 'ask_clarifying_questions') {
    const input = toolUse.input as { questions: string[] };
    return { kind: 'questions', questions: input.questions ?? [] };
  }

  let payload = coercePayload(toolUse.input);
  let errors = validatePayload(payload);

  if (errors.length > 0) {
    logger.warn({ orgId: req.orgId, errors }, 'agent_generate_validation_failed_retrying');
    const retryResponse = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: [CREATE_TOOL],
      tool_choice: { type: 'tool', name: 'create_agent' },
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Your output had these problems — fix them and call create_agent again with a corrected, complete graph:\n${errors.join('\n')}`,
          }],
        },
      ],
    });
    const retryToolUse = retryResponse.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
    if (!retryToolUse) throw new Error('Could not generate a valid agent after a repair attempt.');
    payload = coercePayload(retryToolUse.input);
    errors = validatePayload(payload);
    if (errors.length > 0) {
      throw new Error('Could not generate a valid agent: ' + errors.join('; '));
    }
  }

  applyAutoLayout(payload.nodes, payload.connections);
  return { kind: 'agent', agent: payload };
}

function buildUserMessage(req: GenerateRequest): string {
  const parts = [`REQUIREMENT:\n${req.requirementText.trim()}`];
  if (req.qaHistory && req.qaHistory.length > 0) {
    const qa = req.qaHistory.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n\n');
    parts.push(`PREVIOUSLY ASKED QUESTIONS AND THE USER'S ANSWERS:\n${qa}`);
    parts.push('You now have this additional context. Call create_agent unless something is still genuinely blocking.');
  }
  return parts.join('\n\n');
}

async function fetchProviderStatus(orgId: string): Promise<Array<{ key: string; connected: boolean }>> {
  const conn = await getOrgConnection(orgId);
  const catalog = await conn.query<{ DeveloperName: string }>(
    'SELECT DeveloperName FROM ConnectorCatalog__mdt ORDER BY SortOrder__c ASC',
  );
  const connected = await ConnectorsRepo.listForOrg(orgId);
  const connectedKeys = new Set(connected.filter((c) => c.status === 'Connected').map((c) => c.providerKey));
  // salesforce_mcp is org-level (Setup connection), not a Connector row — treat as connected
  // once the org has completed Archon Setup, which getOrgConnection succeeding already proves.
  connectedKeys.add('salesforce_mcp');
  return catalog.records.map((r) => ({ key: r.DeveloperName, connected: connectedKeys.has(r.DeveloperName) }));
}

function coercePayload(input: unknown): GeneratedAgentPayload {
  const o = (input ?? {}) as Partial<GeneratedAgentPayload>;
  return {
    agent: {
      name: String(o.agent?.name ?? 'Generated Agent'),
      department: String(o.agent?.department ?? 'Sales'),
      description: String(o.agent?.description ?? ''),
      knowledgeBase: String(o.agent?.knowledgeBase ?? ''),
    },
    nodes: Array.isArray(o.nodes) ? o.nodes : [],
    connections: Array.isArray(o.connections) ? o.connections : [],
    setupChecklist: Array.isArray(o.setupChecklist) ? o.setupChecklist : [],
  };
}

const KNOWN_NODES: Record<string, Set<string>> = {
  trigger: new Set(['record']),
  ai: new Set(['claude', 'gpt4', 'gemini']),
  logic: new Set(['if_else', 'set_variable', 'wait', 'approval', 'loop']),
  action: new Set(['get_record', 'update_record', 'create_record', 'query_records', 'create_task', 'post_chatter', 'call_tool']),
  catalog: new Set(['salesforce_crm_tools', 'storage_tools', 'email_tools', 'channel_tools']),
  end: new Set(['end']),
};
const PORTS_BY_SUBTYPE: Record<string, string[]> = {
  if_else: ['yes', 'no'],
  loop: ['each', 'done'],
  approval: ['approved', 'rejected'],
};

function validatePayload(payload: GeneratedAgentPayload): string[] {
  const errors: string[] = [];
  const { nodes, connections } = payload;

  if (nodes.length === 0) errors.push('nodes must not be empty.');

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) errors.push(`Exactly one trigger node is required, found ${triggers.length}.`);
  if (nodes[0]?.type !== 'trigger') errors.push('The trigger node must be at index 0.');

  nodes.forEach((n, i) => {
    const known = KNOWN_NODES[n.type];
    if (!known) { errors.push(`Node ${i} ("${n.label}"): unknown type "${n.type}".`); return; }
    if (!known.has(n.subType)) errors.push(`Node ${i} ("${n.label}"): unknown subType "${n.subType}" for type "${n.type}".`);
  });

  connections.forEach((c, i) => {
    if (!nodes[c.fromIndex]) { errors.push(`Connection ${i}: fromIndex ${c.fromIndex} is out of range.`); return; }
    if (!nodes[c.toIndex]) { errors.push(`Connection ${i}: toIndex ${c.toIndex} is out of range.`); return; }
    const fromSubType = nodes[c.fromIndex].subType;
    const validPorts = PORTS_BY_SUBTYPE[fromSubType] ?? ['out'];
    if (!validPorts.includes(c.fromPort)) {
      errors.push(`Connection ${i}: port "${c.fromPort}" is not valid from a "${fromSubType}" node (valid: ${validPorts.join(', ')}).`);
    }
  });

  // Loop-body constraint — mirrors orchestrator/engine.ts's runtime check.
  nodes.forEach((n, i) => {
    if (n.subType !== 'loop') return;
    const bodyIds = reachableFrom(i, 'each', connections);
    for (const bi of bodyIds) {
      const bodySub = nodes[bi]?.subType;
      if (bodySub === 'wait' || bodySub === 'approval' || bodySub === 'loop') {
        errors.push(`Loop node ${i} ("${n.label}")'s body includes a "${bodySub}" node (${bi}) — wait/approval/nested loops are not supported inside a loop body.`);
      }
    }
  });

  return errors;
}

function reachableFrom(startIndex: number, startPort: string, connections: GeneratedConnection[]): Set<number> {
  const visited = new Set<number>();
  const queue = connections.filter((c) => c.fromIndex === startIndex && c.fromPort === startPort).map((c) => c.toIndex);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    connections.filter((c) => c.fromIndex === cur).forEach((c) => queue.push(c.toIndex));
  }
  return visited;
}

/** Left-to-right layout by BFS depth from the trigger — same grid spacing agentCanvas.handleAutoLayout uses. */
function applyAutoLayout(nodes: GeneratedNode[], connections: GeneratedConnection[]): void {
  const GAP_X = 260;
  const GAP_Y = 140;
  const START_X = 60;
  const START_Y = 80;

  const children = new Map<number, number[]>();
  connections.forEach((c) => {
    if (!children.has(c.fromIndex)) children.set(c.fromIndex, []);
    children.get(c.fromIndex)!.push(c.toIndex);
  });

  const depth = new Array(nodes.length).fill(-1);
  const triggerIdx = Math.max(0, nodes.findIndex((n) => n.type === 'trigger'));
  depth[triggerIdx] = 0;
  const queue = [triggerIdx];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of children.get(cur) ?? []) {
      if (depth[next] === -1) {
        depth[next] = depth[cur] + 1;
        queue.push(next);
      }
    }
  }
  let maxDepth = 0;
  depth.forEach((d) => { if (d > maxDepth) maxDepth = d; });
  nodes.forEach((_, i) => { if (depth[i] === -1) depth[i] = maxDepth + 1; });

  const rowInColumn = new Map<number, number>();
  nodes.forEach((n, i) => {
    const col = depth[i];
    const row = rowInColumn.get(col) ?? 0;
    rowInColumn.set(col, row + 1);
    n.x = START_X + col * GAP_X;
    n.y = START_Y + row * GAP_Y;
  });
}
