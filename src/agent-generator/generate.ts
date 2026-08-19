/**
 * Orchestrates AI agent generation: builds the prompt from spec.ts, calls
 * OpenAI (Responses API, same adapter chat/adapters/openai.ts already
 * uses) with two tools (ask a clarifying question, or commit to a graph),
 * validates the result against the same structural rules the engine itself
 * enforces at runtime, and repairs once on failure before giving up.
 */
import { resolveEngine } from '../chat/engine-resolver';
import type { EngineOverride } from '../chat/engine-resolver';
import { callOpenAi, type OpenAiResponsesResult } from '../chat/adapters/openai';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { ConnectorsRepo } from '../db/connectors.repo';
import { buildSystemPrompt } from './spec';
import { logger } from '../logger';

const MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 8000;
/** At most one clarifying-question round-trip (up to 2 questions in it) before generation is forced. */
export const MAX_QA_ROUNDS = 1;

export type GeneratorMode = 'trigger' | 'chat';

export interface QaTurn { question: string; answer: string; }

export interface GenerateRequest {
  orgId: string;
  requirementText: string;
  qaHistory?: QaTurn[];
  /** Which agent graph vocabulary to generate against — see spec.ts's
   *  CHAT_NODE_SPEC doc comment for why this isn't a single shared prompt.
   *  Defaults to 'trigger' to match AgentDefinition__c.ExecuteType__c's own
   *  field default. */
  mode?: GeneratorMode;
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

// OpenAI Responses API function-tool shape is flat (type/name/description/
// parameters at the top level, no nested `function` wrapper) — matches how
// chat/adapters/openai.ts already declares its own handoff tools.
const ASK_TOOL = {
  type: 'function',
  name: 'ask_clarifying_questions',
  description: 'Ask the user 1-2 short, specific questions ONLY when the requirement is genuinely too ambiguous to build a sensible agent. Prefer a reasonable default + a checklist note over asking, whenever possible.',
  parameters: {
    type: 'object',
    properties: {
      questions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    },
    required: ['questions'],
  },
};

const CREATE_TOOL = {
  type: 'function',
  name: 'create_agent',
  description: 'Create a complete Archon agent graph from the requirement.',
  parameters: {
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

interface FunctionCallBlock { type: 'function_call'; id?: string; call_id?: string; name: string; arguments: string; }

function findFunctionCall(output: OpenAiResponsesResult['output'], name?: string): FunctionCallBlock | undefined {
  return (output ?? []).find(
    (b): b is FunctionCallBlock => b.type === 'function_call' && (b as FunctionCallBlock).name != null && (!name || (b as FunctionCallBlock).name === name)
  );
}

function parseCallArguments(call: FunctionCallBlock): unknown {
  try {
    return JSON.parse(call.arguments);
  } catch {
    return {};
  }
}

export async function generateAgent(req: GenerateRequest, engineOverride?: EngineOverride | null): Promise<GenerateResult> {
  const mode: GeneratorMode = req.mode ?? 'trigger';
  const creds = resolveEngine('openai', engineOverride);
  const model = creds.defaultModel || MODEL;

  const providerStatus = await fetchProviderStatus(req.orgId).catch((err) => {
    logger.warn({ err, orgId: req.orgId }, 'agent_generate_provider_status_failed');
    return [];
  });
  const systemPrompt = buildSystemPrompt(providerStatus, mode);
  const userMessage = buildUserMessage(req);
  // Exactly one clarification round-trip, regardless of how many questions
  // are in it (the tool itself caps a single call at 2 questions) — once
  // the user has answered anything, generation is forced on this call.
  const canStillAsk = !req.qaHistory || req.qaHistory.length === 0;

  const baseBody = {
    model,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'user', content: [{ type: 'input_text', text: userMessage }] },
    ],
  };

  const response = await callOpenAi(
    {
      ...baseBody,
      tools: canStillAsk ? [ASK_TOOL, CREATE_TOOL] : [CREATE_TOOL],
      tool_choice: canStillAsk ? 'required' : { type: 'function', name: 'create_agent' },
    },
    creds.apiKey,
  );
  if (response.error) throw new Error(response.error.message ?? 'OpenAI API error');

  const askCall = findFunctionCall(response.output, 'ask_clarifying_questions');
  if (askCall) {
    const input = parseCallArguments(askCall) as { questions: string[] };
    return { kind: 'questions', questions: input.questions ?? [] };
  }

  const createCall = findFunctionCall(response.output, 'create_agent');
  if (!createCall) {
    throw new Error('The model did not return a usable response. Try rephrasing the requirement.');
  }

  let payload = coercePayload(parseCallArguments(createCall));
  let errors = validatePayload(payload, mode);

  if (errors.length > 0) {
    logger.warn({ orgId: req.orgId, errors }, 'agent_generate_validation_failed_retrying');
    // previous_response_id continuation — same pattern chat/adapters/
    // openai.ts's narration-only guard already uses, rather than manually
    // replaying the whole conversation the way Anthropic's tool_result flow
    // needs to.
    const retryResponse = await callOpenAi(
      {
        model,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        tools: [CREATE_TOOL],
        tool_choice: { type: 'function', name: 'create_agent' },
        previous_response_id: response.id,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Your output had these problems — fix them and call create_agent again with a corrected, complete graph:\n${errors.join('\n')}`,
          }],
        }],
      },
      creds.apiKey,
    );
    if (retryResponse.error) throw new Error(retryResponse.error.message ?? 'OpenAI API error');
    const retryCall = findFunctionCall(retryResponse.output, 'create_agent');
    if (!retryCall) throw new Error('Could not generate a valid agent after a repair attempt.');
    payload = coercePayload(parseCallArguments(retryCall));
    errors = validatePayload(payload, mode);
    if (errors.length > 0) {
      throw new Error('Could not generate a valid agent: ' + errors.join('; '));
    }
  }

  normalizeSalesforceCatalogTools(payload.nodes);
  applyAutoLayout(payload.nodes, payload.connections, mode);
  return { kind: 'agent', agent: payload };
}

/** The runtime enforces a catalog's allowedTools by EXACT name against the
 *  live MCP server — a name the server doesn't expose silently gives the
 *  agent no tools at all (found the hard way: a generated agent shipped
 *  get_record/query_records/... from this spec's old stale vocabulary and
 *  ended up with zero working Salesforce tools while looking fine on the
 *  canvas). The spec now teaches the real names; this is the belt to that
 *  suspenders — map legacy spellings to the live server's names and drop
 *  anything still unrecognized, falling back to the read-only set rather
 *  than an empty (i.e. useless) catalog. */
const SF_TOOL_ALIASES: Record<string, string> = {
  query_records: 'soqlQuery',
  get_record: 'soqlQuery',
  run_report: 'soqlQuery',
  list_sobjects: 'getObjectSchema',
  describe_sobject: 'getObjectSchema',
  get_related_records: 'getRelatedRecords',
  create_record: 'createSobjectRecord',
  create_task: 'createSobjectRecord',
  post_chatter: 'createSobjectRecord',
  update_record: 'updateSobjectRecord',
  delete_record: 'deleteSobjectRecord',
};
const SF_REAL_TOOLS = new Set([
  'soqlQuery', 'getObjectSchema', 'getRelatedRecords', 'getUserInfo', 'listRecentSobjectRecords', 'find',
  'createSobjectRecord', 'updateSobjectRecord', 'deleteSobjectRecord', 'updateRelatedRecord', 'deleteRelatedRecord',
]);
const SF_READONLY_DEFAULT = ['soqlQuery', 'getObjectSchema', 'getRelatedRecords', 'getUserInfo'];

function normalizeSalesforceCatalogTools(nodes: GeneratedNode[]): void {
  for (const n of nodes) {
    if (n.type !== 'catalog' || n.subType !== 'salesforce_crm_tools') continue;
    const raw = Array.isArray(n.config.allowedTools) ? (n.config.allowedTools as unknown[]).map(String) : [];
    const normalized = [...new Set(raw.map((t) => SF_TOOL_ALIASES[t] ?? t).filter((t) => SF_REAL_TOOLS.has(t)))];
    n.config.allowedTools = normalized.length > 0 ? normalized : [...SF_READONLY_DEFAULT];
    // The runtime maps a catalog to its MCP server via config.provider —
    // without it the connector is never attached and the catalog is
    // decorative (the second half of the same silent-failure bug).
    if (!n.config.provider) n.config.provider = 'salesforce_mcp';
  }
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

const TRIGGER_KNOWN_NODES: Record<string, Set<string>> = {
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

/** Chat mode has no trigger/logic/action/end vocabulary — see spec.ts's
 *  CHAT_NODE_SPEC. subagent's '' subType means "inherit the top-level ai
 *  node's provider" (matches subagent-router.ts's toSyntheticAiNode
 *  fallback); tool's subType free-forms to the same MCP/Apex/Flow enum as
 *  its own config.actionType. */
const CHAT_KNOWN_NODES: Record<string, Set<string>> = {
  ai: new Set(['claude', 'gpt4', 'gemini']),
  subagent: new Set(['claude', 'gpt4', 'gemini', '']),
  tool: new Set(['MCP', 'Apex', 'Flow']),
  catalog: new Set(['salesforce_crm_tools', 'storage_tools', 'email_tools', 'channel_tools']),
};

function validatePayload(payload: GeneratedAgentPayload, mode: GeneratorMode): string[] {
  return mode === 'chat' ? validateChatPayload(payload) : validateTriggerPayload(payload);
}

function validateTriggerPayload(payload: GeneratedAgentPayload): string[] {
  const errors: string[] = [];
  const { nodes, connections } = payload;

  if (nodes.length === 0) errors.push('nodes must not be empty.');

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) errors.push(`Exactly one trigger node is required, found ${triggers.length}.`);
  if (nodes[0]?.type !== 'trigger') errors.push('The trigger node must be at index 0.');

  nodes.forEach((n, i) => {
    const known = TRIGGER_KNOWN_NODES[n.type];
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

/** CRITICAL: subagent-router.ts's nextNodes(graph, aiNode.id, 'tool') does an
 *  exact string match on fromPort — any subagent/tool connection NOT using
 *  fromPort="tool" renders as connected on the canvas but is silently
 *  invisible and uncallable at real chat runtime. This is checked here as a
 *  hard error (not a lint), specifically so a wiring mistake gets caught and
 *  repaired before the agent ever reaches a user. Catalog connections are
 *  NOT checked — discoverAllowedTools() (server/src/chat/adapters/shared.ts)
 *  matches on node-id adjacency only, ignoring port, so catalog attachment
 *  is genuinely port-agnostic. */
function validateChatPayload(payload: GeneratedAgentPayload): string[] {
  const errors: string[] = [];
  const { nodes, connections } = payload;

  if (nodes.length === 0) errors.push('nodes must not be empty.');

  const roots = nodes.filter((n) => n.type === 'ai');
  if (roots.length !== 1) errors.push(`Exactly one top-level "ai" node is required, found ${roots.length}.`);
  if (nodes[0]?.type !== 'ai') errors.push('The top-level "ai" node must be at index 0.');

  nodes.forEach((n, i) => {
    const known = CHAT_KNOWN_NODES[n.type];
    if (!known) { errors.push(`Node ${i} ("${n.label}"): unknown type "${n.type}" for chat mode (trigger/logic/action/end nodes do not exist in the chat engine).`); return; }
    if (!known.has(n.subType)) errors.push(`Node ${i} ("${n.label}"): unknown subType "${n.subType}" for type "${n.type}".`);
  });

  connections.forEach((c, i) => {
    if (!nodes[c.fromIndex]) { errors.push(`Connection ${i}: fromIndex ${c.fromIndex} is out of range.`); return; }
    if (!nodes[c.toIndex]) { errors.push(`Connection ${i}: toIndex ${c.toIndex} is out of range.`); return; }
    const toType = nodes[c.toIndex].type;
    if ((toType === 'subagent' || toType === 'tool') && c.fromPort !== 'tool') {
      errors.push(`Connection ${i}: targets a "${toType}" node but uses fromPort="${c.fromPort}" — must be exactly fromPort="tool" or this node will be invisible at chat runtime.`);
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

/** Left-to-right layout by BFS depth from the root node (trigger in trigger
 *  mode, the top-level ai node in chat mode — both always index 0 once
 *  validated) — same grid spacing agentCanvas.handleAutoLayout uses. */
function applyAutoLayout(nodes: GeneratedNode[], connections: GeneratedConnection[], mode: GeneratorMode): void {
  const GAP_X = 260;
  const GAP_Y = 140;
  const START_X = 60;
  const START_Y = 80;
  const rootType = mode === 'chat' ? 'ai' : 'trigger';

  const children = new Map<number, number[]>();
  connections.forEach((c) => {
    if (!children.has(c.fromIndex)) children.set(c.fromIndex, []);
    children.get(c.fromIndex)!.push(c.toIndex);
  });

  const depth = new Array(nodes.length).fill(-1);
  const rootIdx = Math.max(0, nodes.findIndex((n) => n.type === rootType));
  depth[rootIdx] = 0;
  const queue = [rootIdx];
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
