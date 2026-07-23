import { register } from './registry';
import type { NodeExecutor } from './registry';

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

/** Wait — async sleep. Capped at 30s for sync mode (Apex callout timeout). */
const waitExec: NodeExecutor = async (node) => {
  const delay = Math.min(Number(node.config.delayMs ?? 0), 30_000);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return {
    nodeId: node.id,
    nodeSubType: 'wait',
    success: true,
    output: { delayedMs: delay },
  };
};

register('wait', waitExec);

/** Loop / approval — placeholders that just pass through for now. */
register('loop', async (node, ctx) => ({
  nodeId: node.id,
  nodeSubType: 'loop',
  success: true,
  output: { note: 'loop not implemented in MVP — passes through' },
}));

register('approval', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'approval',
  success: true,
  output: { note: 'approval not implemented in MVP — auto-approved' },
}));

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
