/**
 * The generator's knowledge of "what Archon can build with" — a deliberate,
 * separate copy of what already lives in two other places (client
 * FIELD_SCHEMAS in agentPropertiesPanel.js, server node registry in
 * nodes/*.ts). Keeping three hand-synced copies is a real cost — see the
 * plan doc for why this isn't unified in this pass. If you add/change a
 * node type anywhere else, update this file too.
 *
 * Only node subtypes that are PROVEN, live-wired executors are listed —
 * legacy per-provider action nodes (outlook/gmail/slack/...) are
 * deliberately excluded in favor of the generic call_tool node, and
 * schedule triggers are excluded because scheduled execution isn't wired
 * to a real cron/poller yet (Phase 3, blocked on infra).
 */

export interface NodeSpecField {
  key: string;
  type: string;
  description: string;
  example?: string;
}

export interface NodeSpecEntry {
  type: string;
  subType: string;
  label: string;
  when: string;
  ports: string[];
  fields: NodeSpecField[];
}

export const NODE_SPEC: NodeSpecEntry[] = [
  {
    type: 'trigger', subType: 'record', label: 'Record Trigger',
    when: 'Every agent needs EXACTLY ONE of these, as the first node. Fires when a Salesforce record is created and/or updated.',
    ports: ['out'],
    fields: [
      { key: 'objectType', type: 'text', description: 'Salesforce object API name.', example: 'Lead' },
      { key: 'triggerOn', type: 'picklist(Create,Update,Create or Update)', description: 'When to fire.' },
    ],
  },
  {
    type: 'ai', subType: 'claude', label: 'Claude (AI step)',
    when: 'Use for any step that needs judgment, scoring, summarization, or deciding which tool to call — not for simple deterministic CRUD (use action nodes for that).',
    ports: ['out'],
    fields: [
      { key: 'model', type: 'picklist(claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5)', description: 'Default to claude-sonnet-4-6 unless the task clearly needs top reasoning quality (opus) or is trivial/high-volume (haiku).' },
      { key: 'instruction', type: 'textarea', description: 'Plain-English instruction. This is the most important field — be specific about what to look up, what to decide, and what action to take or recommend. Reference {!record.Field} for trigger data.', example: 'Look up the {!record.Company} and {!record.Industry}. Score 0-100 how likely this lead is to convert. Give one short sentence of reasoning.' },
      { key: 'useKnowledgeBase', type: 'toggle', description: 'true if this step should ground its answer in the agent-level Knowledge Base (Notes text or uploaded documents).' },
    ],
  },
  { type: 'ai', subType: 'gpt4', label: 'GPT-4 (AI step)', when: 'Same as claude — use only if the user specifically asked for OpenAI/GPT.', ports: ['out'],
    fields: [
      { key: 'model', type: 'picklist(gpt-4o,gpt-4o-mini,gpt-4-turbo,gpt-4.1,gpt-4.1-mini)', description: 'Default gpt-4o.' },
      { key: 'instruction', type: 'textarea', description: 'Same as claude.instruction.' },
      { key: 'useKnowledgeBase', type: 'toggle', description: 'Same as claude.useKnowledgeBase.' },
    ] },
  { type: 'ai', subType: 'gemini', label: 'Gemini (AI step)', when: 'Same as claude — use only if the user specifically asked for Gemini/Google AI.', ports: ['out'],
    fields: [
      { key: 'model', type: 'picklist(gemini-2.5-pro,gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite)', description: 'Default gemini-2.5-flash.' },
      { key: 'instruction', type: 'textarea', description: 'Same as claude.instruction.' },
      { key: 'useKnowledgeBase', type: 'toggle', description: 'Same as claude.useKnowledgeBase.' },
    ] },
  {
    type: 'logic', subType: 'if_else', label: 'If/Else',
    when: 'Branch the flow on a condition. Almost always follows an AI step (score/priority) or a deterministic field check.',
    ports: ['yes', 'no'],
    fields: [
      { key: 'condition', type: 'text', description: 'EXACTLY the shape "<lhs> <op> <rhs>" where op is one of == != > < >= <=. lhs/rhs can be a {!variable} or a literal. Quotes optional for strings.', example: '{!ai.score} > 70' },
    ],
  },
  {
    type: 'logic', subType: 'set_variable', label: 'Set Variable',
    when: 'Store a computed/combined value under a name you choose, to reference later as {!yourName.value}. Useful for assembling a message from several upstream fields.',
    ports: ['out'],
    fields: [
      { key: 'variableName', type: 'text', description: 'Letters/numbers only, no spaces. This becomes the token name.', example: 'summary' },
      { key: 'template', type: 'text', description: 'The value — plain text mixed with {!variable} references.', example: 'Lead {!record.Name} scored {!ai.score}' },
    ],
  },
  {
    type: 'logic', subType: 'wait', label: 'Wait',
    when: 'Pause before continuing. Durable — survives a server restart for waits longer than 60 seconds.',
    ports: ['out'],
    fields: [
      { key: 'delayValue', type: 'number', description: 'A positive number.' },
      { key: 'delayUnit', type: 'picklist(seconds,minutes,hours,days)', description: 'Unit for delayValue.' },
    ],
  },
  {
    type: 'logic', subType: 'approval', label: 'Approval',
    when: 'Pause for a human decision before continuing. Use when the requirement mentions review, sign-off, or manager approval before an action (especially a costly/irreversible one, like a discount or a mass email).',
    ports: ['approved', 'rejected'],
    fields: [
      { key: 'approverField', type: 'text', description: 'A field on the TRIGGER object that resolves to a User Id — a direct field (OwnerId) or a relationship path (Owner.ManagerId).', example: 'OwnerId' },
      { key: 'timeoutHours', type: 'number', description: 'Auto-reject if nobody decides within this many hours. Use a sane business default (e.g. 24 or 48) unless the requirement states one.' },
    ],
  },
  {
    type: 'logic', subType: 'loop', label: 'Loop',
    when: 'Repeat a set of steps once per item in a list (e.g. a list of records from a query_records node). The "each" port is the loop body (runs once per item); the "done" port runs once after all iterations finish. IMPORTANT: never put a wait, approval, or another loop node inside the each-port body — not supported and will fail validation.',
    ports: ['each', 'done'],
    fields: [
      { key: 'collectionVar', type: 'text', description: 'A {!variable} that resolves to a list — typically {!action.records} right after a query_records node (the alias is the upstream node\'s TYPE, "action", not its subtype).', example: '{!action.records}' },
      { key: 'iteratorVar', type: 'text', description: 'Name for the current item, referenced downstream in the each-body as {!thatName.FieldName}.', example: 'item' },
      { key: 'maxIterations', type: 'number', description: 'Cap, hard-limited to 100 regardless of this value. Default 25.' },
    ],
  },
  { type: 'action', subType: 'get_record', label: 'Get Record', when: 'Fetch one record\'s fields deterministically (no AI judgment).', ports: ['out'],
    fields: [ { key: 'objectType', type: 'text', description: 'Object API name.' }, { key: 'fields', type: 'text', description: 'Comma-separated field API names.' } ] },
  { type: 'action', subType: 'update_record', label: 'Update Record', when: 'Deterministically update fields on a record — the trigger record by default.', ports: ['out'],
    fields: [ { key: 'objectType', type: 'text', description: 'Object API name.' }, { key: 'fieldMappings', type: 'json-text', description: 'JSON object of Field: value pairs. Values can contain {!variable} tokens.', example: '{"Status__c":"Hot","Score__c":"{!ai.score}"}' } ] },
  { type: 'action', subType: 'create_record', label: 'Create Record', when: 'Deterministically create a new record of any type.', ports: ['out'],
    fields: [ { key: 'objectType', type: 'text', description: 'Object API name.' }, { key: 'fieldMappings', type: 'json-text', description: 'JSON object of Field: value pairs.', example: '{"Subject":"Follow up","Priority":"High"}' } ] },
  { type: 'action', subType: 'query_records', label: 'Query Records', when: 'Run a SOQL query and get back a list — the natural upstream of a Loop node.', ports: ['out'],
    fields: [ { key: 'soql', type: 'text', description: 'A real SOQL query. Output lands in {!action.records} (array) and {!action.count}.', example: "SELECT Id, Name FROM Contact WHERE AccountId = '{!record.Id}'" } ] },
  { type: 'action', subType: 'create_task', label: 'Create Task', when: 'Shortcut for creating a Salesforce Task — simpler than create_record for this specific, very common case.', ports: ['out'],
    fields: [ { key: 'subject', type: 'text', description: 'Task subject, can use {!variable}.' }, { key: 'dueDate', type: 'text', description: 'TODAY, TODAY+N, or a literal date.' }, { key: 'priority', type: 'picklist(High,Normal,Low)', description: '' } ] },
  { type: 'action', subType: 'post_chatter', label: 'Post to Chatter', when: 'Post an update to the trigger record\'s Chatter feed.', ports: ['out'],
    fields: [ { key: 'message', type: 'text', description: 'Message text, can use {!variable}.' } ] },
  {
    type: 'action', subType: 'call_tool', label: 'Call a Tool',
    when: 'THE way to take action through a connected external provider (email, Slack, storage, or even a Salesforce MCP tool) deterministically — no AI judgment, just call one specific tool with specific parameters. This replaces per-provider node types; do not invent an "outlook" or "slack" node type, always use call_tool with the right provider.',
    ports: ['out'],
    fields: [
      { key: 'provider', type: 'text', description: 'A provider key — see the CONNECTED PROVIDERS list below for what this org has. Use the closest match even if not yet connected (e.g. "gmail" for email) — connecting it becomes a checklist item.' },
      { key: 'connectorId', type: 'text', description: 'Leave empty string — the user binds this after connecting the provider.' },
      { key: 'toolKind', type: 'picklist(standard,custom)', description: 'Always "standard" unless the requirement explicitly references the org\'s own custom Apex/Flow action.' },
      { key: 'toolName', type: 'text', description: 'The specific tool name. For gmail: sendEmail, listEmails, readEmail, searchEmails, replyEmail, createDraft. For slack-like channel providers: postMessage. Best-guess a sensible name if unsure — the user can correct it via the tool picker, which shows the real live list.' },
      { key: 'paramValues', type: 'json-text', description: 'JSON object mapping the tool\'s real parameter names to values (which can contain {!variable} tokens). For gmail sendEmail: {"to":"[\\"{!record.Email}\\"]","subject":"...","body":"..."} — note "to" is a JSON array, so its value must itself be a JSON-array STRING.' },
    ],
  },
  { type: 'catalog', subType: 'salesforce_crm_tools', label: 'Salesforce Tools (catalog)', when: 'Attach to an AI node so it can look up/query/act on Salesforce data itself mid-reasoning (as opposed to a deterministic action node). Wire it downstream of the AI node it belongs to, same port as the AI node\'s "out".', ports: [],
    fields: [ { key: 'description', type: 'text', description: 'Shown to the AI — what this catalog is for.' }, { key: 'connectorId', type: 'text', description: 'Leave empty string.' }, { key: 'allowedTools', type: 'string[]', description: 'Subset of: list_sobjects, describe_sobject, get_record, query_records, run_report, create_record, update_record, delete_record, create_task, post_chatter, apex_invocable. Prefer read-only tools unless the requirement clearly needs writes.' } ] },
  { type: 'catalog', subType: 'email_tools', label: 'Email Tools (catalog)', when: 'Attach to an AI node so it can read/send email itself mid-reasoning.', ports: [],
    fields: [ { key: 'description', type: 'text', description: 'Shown to the AI.' }, { key: 'connectorId', type: 'text', description: 'Leave empty string.' }, { key: 'allowedTools', type: 'string[]', description: 'Subset of: list_emails, read_email, search_emails, send_email, reply_email, forward_email, create_draft, send_template.' } ] },
  { type: 'catalog', subType: 'storage_tools', label: 'Storage Tools (catalog)', when: 'Attach to an AI node so it can read/write cloud storage files itself mid-reasoning.', ports: [],
    fields: [ { key: 'description', type: 'text', description: 'Shown to the AI.' }, { key: 'connectorId', type: 'text', description: 'Leave empty string.' }, { key: 'allowedTools', type: 'string[]', description: 'Subset of: list_files, read_file, search, get_file_metadata, write_file, update_file, create_folder, move_file, delete_file, share_file.' } ] },
  { type: 'catalog', subType: 'channel_tools', label: 'Channel Tools (catalog)', when: 'Attach to an AI node so it can post to chat channels itself mid-reasoning.', ports: [],
    fields: [ { key: 'description', type: 'text', description: 'Shown to the AI.' }, { key: 'connectorId', type: 'text', description: 'Leave empty string.' }, { key: 'allowedTools', type: 'string[]', description: 'Subset of: list_channels, list_users, read_channel_history, post_message, update_message, add_reaction, upload_file.' } ] },
  { type: 'end', subType: 'end', label: 'End', when: 'Optional terminal marker — most agents do not need one; only add it if the requirement explicitly wants execution logged.', ports: [],
    fields: [ { key: 'logExecution', type: 'toggle', description: 'true to log this run to Salesforce.' } ] },
];

/** Renders the spec + live connector status into the generation system prompt. */
export function buildSystemPrompt(providerStatus: Array<{ key: string; connected: boolean }>): string {
  const nodeBlock = NODE_SPEC.map((n) => {
    const fields = n.fields.length
      ? n.fields.map((f) => `    - ${f.key} (${f.type}): ${f.description}${f.example ? ` e.g. ${JSON.stringify(f.example)}` : ''}`).join('\n')
      : '    (no config fields)';
    return `- type="${n.type}" subType="${n.subType}" ("${n.label}") — ports: [${n.ports.join(', ') || 'none, terminal'}]\n  When to use: ${n.when}\n  Config fields:\n${fields}`;
  }).join('\n\n');

  const providerBlock = providerStatus.length
    ? providerStatus.map((p) => `- ${p.key}${p.connected ? ' (connected)' : ' (not connected yet — using it is fine, it becomes a checklist item)'}`).join('\n')
    : '(no providers configured in this org yet — any provider you reference becomes a checklist item)';

  return `You are Archon's agent-generation assistant. You turn a plain-English automation requirement into a complete, valid Archon agent graph.

ARCHON'S NODE TYPES:
${nodeBlock}

CONNECTED PROVIDERS IN THIS ORG:
${providerBlock}

VARIABLE / INTERPOLATION SYNTAX:
- {!record.FieldName} — a field on the record that triggered the run (the object named in the trigger node's objectType).
- {!recordId} — the triggering record's raw Id.
- {!ai.score}, {!ai.priority}, {!ai.finalText} — the most recent AI node's output (always these exact names, regardless of node label).
- {!action.records}, {!action.count} — the most recent action-type node's output (query_records puts its results here).
- {!<name>.value} — a Set Variable node's stored value, where <name> is whatever variableName you gave it.
- {!<iteratorVar>.FieldName} — inside a Loop's each-body, the current item (iteratorVar is whatever you named it on the loop node).

GRAPH STRUCTURE RULES:
- Exactly one trigger node, always node index 0, always type="trigger" subType="record".
- Connections reference nodes by ARRAY INDEX (fromIndex/toIndex into the nodes array you return), with fromPort/toPort — toPort is always "in" except loop bodies use the node's own port name as documented above.
- Every non-terminal node needs at least one outgoing connection, or the flow silently dead-ends there.
- if_else should usually wire BOTH yes and no somewhere (even if "no" just goes to a no-op end) — an unwired branch is a silent no-op, not an error, but it is usually a mistake.
- Catalog nodes (salesforce_crm_tools/email_tools/storage_tools/channel_tools) connect FROM the ai node they belong to, on that ai node's "out" port — they are the ai node's toolset, not a step in the main flow.
- Be PROACTIVE: if the requirement clearly implies structure it didn't spell out (e.g. "answer questions from our FAQ" implies useKnowledgeBase=true and possibly a KB catalog; "notify the team" without naming a channel implies a call_tool or channel_tools node using the best-matching connected provider), include it — but set a one-sentence "rationale" on that specific node explaining why you added it. Do not invent unrelated features.
- Never fabricate a provider that isn't Salesforce/email/storage/channel in nature — if the requirement needs something Archon genuinely can't do, omit it and explain the gap in the setup checklist instead of inventing a fake node type.

Decide whether to call ask_clarifying_questions or create_agent. Only ask questions when truly blocked (e.g. an approval step with no named or inferable approver, a notification with no possible channel/provider match at all) — prefer a reasonable default plus a checklist note over asking.`;
}
