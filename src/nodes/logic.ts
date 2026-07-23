import { randomUUID } from 'crypto';
import { register } from './registry';
import type { NodeExecutor } from './registry';
import type { ExecutionContext } from '../orchestrator/context';

/**
 * If/else node — evaluates `config.condition` against current context state.
 * Returns `nextPort: 'yes' | 'no'` so the engine can branch.
 *
 * Supported condition shapes (intentionally simple — engine evaluates, not Claude):
 *   "{!ai.score} > 80"
 *   "{!record.Status} == 'New'"
 *   "{!ai.priority} != 'Cold'"
 */
const ifElseExec: NodeExecutor = async (node, ctx) => {
  const raw = String(node.config.condition ?? '').trim();
  const condition = ctx.interpolate(raw);
  const result = evalCondition(condition);

  return {
    nodeId: node.id,
    nodeSubType: 'if_else',
    success: true,
    output: { condition, result },
    nextPort: result ? 'yes' : 'no',
  };
};

register('if_else', ifElseExec);

/**
 * Set Variable — Flow-style Assignment. Interpolates `config.template` and
 * stores it under the user-chosen `config.variableName`, which the engine
 * registers as an EXTRA alias (see ExecutionContext.recordResult) so
 * downstream nodes reference it the same way they reference {!ai.score}:
 * `{!myVariableName.value}`.
 */
const setVariableExec: NodeExecutor = async (node, ctx) => {
  const varName = String(node.config.variableName ?? '').trim();
  const value = ctx.interpolate(String(node.config.template ?? ''));
  return {
    nodeId: node.id,
    nodeSubType: 'set_variable',
    success: true,
    output: { value },
    customAlias: varName || undefined,
  };
};

register('set_variable', setVariableExec);

const MS_PER_UNIT: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};
/** Delays this short or shorter just sleep inline — no persistence overhead for a <=1min wait. */
const INLINE_WAIT_CEILING_MS = 60_000;

/**
 * Wait — durable delay. Short waits (<=60s) sleep inline exactly like
 * before; anything longer signals `pause` and the engine persists the run
 * and stops instead of blocking a request thread for hours/days. The
 * poller (server/src/scheduler/run-poller.ts) resumes it once due.
 */
const waitExec: NodeExecutor = async (node) => {
  const config = node.config as { delayValue?: number; delayUnit?: string };
  const value = Math.max(0, Number(config.delayValue) || 0);
  const unit = MS_PER_UNIT[config.delayUnit ?? 'minutes'] ? config.delayUnit! : 'minutes';
  const ms = value * MS_PER_UNIT[unit];

  if (ms <= INLINE_WAIT_CEILING_MS) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return { nodeId: node.id, nodeSubType: 'wait', success: true, output: { delayedMs: ms, mode: 'inline' } };
  }

  const resumeAt = new Date(Date.now() + ms).toISOString();
  return {
    nodeId: node.id,
    nodeSubType: 'wait',
    success: true,
    output: { resumeAt, mode: 'durable' },
    pause: { kind: 'wait', resumeAt },
  };
};

register('wait', waitExec);

/**
 * Loop — the real per-iteration engine work lives in orchestrator/engine.ts
 * (runLoopNode): it needs the graph + nested BFS a plain NodeExecutor
 * doesn't have access to, so the engine special-cases `nodeSubType==='loop'`
 * BEFORE reaching the registry. This registration only exists so a stray
 * lookup (e.g. echoExecutor fallback logic) never silently no-ops one.
 */
register('loop', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'loop',
  success: false,
  error: 'Loop nodes are handled by the engine directly and should never reach this executor — this indicates a bug.',
}));

/**
 * Approval — resolves an approver from the trigger record (supports
 * relationship paths like "Owner.ManagerId"), creates a real
 * AgentApproval__c record in the customer's org, then pauses. Resumes via
 * AgentApprovalController.decide() -> POST /api/agent/runs/resume, or the
 * poller's timeout sweep if nobody responds in time.
 */
const approvalExec: NodeExecutor = async (node, ctx) => {
  const config = node.config as { approverField?: string; timeoutHours?: number };
  const approverField = String(config.approverField ?? 'OwnerId').trim() || 'OwnerId';
  const timeoutHours = Number(config.timeoutHours) || 0;

  const approverId = await resolveApprover(ctx, approverField);
  if (!approverId) {
    return {
      nodeId: node.id, nodeSubType: 'approval', success: false,
      error: `Could not resolve an approver from field "${approverField}" on the trigger record.`,
    };
  }

  const approvalToken = randomUUID();
  const timeoutAt = timeoutHours > 0 ? new Date(Date.now() + timeoutHours * 3_600_000) : null;

  await ctx.conn.sobject('AgentApproval__c').create({
    AgentRunId__c: ctx.runId ?? '',
    AgentApiName__c: ctx.agent.apiName,
    NodeLabel__c: node.name?.slice(0, 255) ?? 'Approval',
    RecordId__c: ctx.recordId || null,
    ApproverId__c: approverId,
    Status__c: 'Pending',
    ApprovalToken__c: approvalToken,
    TimeoutAt__c: timeoutAt ? timeoutAt.toISOString() : null,
  });

  return {
    nodeId: node.id,
    nodeSubType: 'approval',
    success: true,
    output: { approvalToken, approverId, status: 'Pending' },
    pause: { kind: 'approval', approvalToken, timeoutAt: timeoutAt?.toISOString() },
  };
};

register('approval', approvalExec);

/** Walks a (possibly dotted, e.g. "Owner.ManagerId") field path against the trigger record via a fresh SOQL query. */
async function resolveApprover(ctx: ExecutionContext, approverField: string): Promise<string | null> {
  const triggerNode = ctx.agent.nodes.find((n) => n.nodeType === 'trigger');
  const objectType = (triggerNode?.config as { objectType?: string } | undefined)?.objectType;
  if (!objectType || !ctx.recordId) return null;

  const safeField = approverField.replace(/[^a-zA-Z0-9_.]/g, '');
  if (!safeField) return null;
  const safeRecordId = ctx.recordId.replace(/[^a-zA-Z0-9]/g, '');

  try {
    const res = await ctx.conn.query<Record<string, unknown>>(
      `SELECT ${safeField} FROM ${objectType} WHERE Id = '${safeRecordId}' LIMIT 1`,
    );
    const rec = res.records[0];
    if (!rec) return null;
    let cur: unknown = rec;
    for (const part of safeField.split('.')) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
      else return null;
    }
    return typeof cur === 'string' && cur ? cur : null;
  } catch {
    return null;
  }
}

function evalCondition(expr: string): boolean {
  // Very narrow evaluator — supports `<lhs> <op> <rhs>` only.
  // We intentionally avoid `eval()` / `Function()` for security.
  const match = expr.match(/^\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!match) return Boolean(expr);
  const [, lhs, op, rhs] = match;
  const a = coerce(stripQuotes(lhs));
  const b = coerce(stripQuotes(rhs));
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>':  return Number(a) > Number(b);
    case '<':  return Number(a) < Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<=': return Number(a) <= Number(b);
    default:   return false;
  }
}

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(s: string): string | number | boolean {
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  return Number.isFinite(n) && s.trim() !== '' ? n : s;
}
