import { register } from './registry';
import type { NodeExecutor } from './registry';
import { runHeadlessAiStep, parseScoreTail } from '../chat/headless';
import { logger } from '../logger';

/**
 * AI orchestrator nodes for FLOW (trigger-mode) runs — claude / gpt4.
 *
 * Replaces the old ai.ts two-tier/flat dispatch loop entirely: this calls
 * the SAME headless-chat path chat mode uses, so Managed MCP tools, custom
 * Apex/Flow tools, and per-user engine credentials behave identically in
 * chat and in flows. (Registered AFTER nodes/ai.ts in engine.ts's
 * side-effect imports, so these overwrite ai.ts's claude/gpt4 placeholders
 * — gemini/einstein/sentiment/embed there are untouched.)
 */
const aiStepExec = (subType: 'claude' | 'gpt4'): NodeExecutor => async (node, ctx) => {
  try {
    const result = await runHeadlessAiStep(ctx, node);
    const { score, priority, cleanText } = parseScoreTail(result.assistantText);

    logger.info({
      nodeId: node.id, subType, orgId: ctx.orgId,
      toolCallCount: result.toolCalls.length, modelUsed: result.modelUsed,
    }, 'flow_ai_step_complete');

    return {
      nodeId: node.id,
      nodeSubType: subType,
      success: true,
      output: {
        finalText: cleanText,
        toolCalls: result.toolCalls,
        modelUsed: result.modelUsed,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      },
      score,
      priority,
      reason: cleanText,
      toolsUsed: result.toolCalls.map(c => `${c.name}${c.isError ? '(err)' : ''}`),
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id, subType }, 'flow_ai_step_failed');
    return { nodeId: node.id, nodeSubType: subType, success: false, error: (err as Error).message };
  }
};

register('claude', aiStepExec('claude'));
register('gpt4', aiStepExec('gpt4'));
