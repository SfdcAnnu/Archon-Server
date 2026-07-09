import { register } from './registry';
import { callClaude } from '../mcp/servers/anthropic-models';
import {
  callOpenAi,
  callOpenAiWithTools,
  runTwoTierLoop,
  type CatalogForTwoTier,
  type OpenAiTool,
} from '../mcp/servers/openai-models';
import { callGemini } from '../mcp/servers/gemini-models';
import {
  dispatchTool,
  getCatalogTools,
  type CatalogSubType,
  type ToolDef,
} from '../mcp/dispatcher';
import type { NodeExecutor } from './registry';
import type { AgentNode, NodeResult } from '../types';
import type { ExecutionContext } from '../orchestrator/context';
import { logger } from '../logger';

/**
 * AI model nodes (claude/gpt4/gemini) are ORCHESTRATORS.
 *
 * When one runs:
 *   1. Walk downstream and collect attached tool catalog nodes
 *   2. Build the combined toolset from their allowedTools
 *   3. Run the chosen dispatch mode (two_tier or flat)
 *      - two_tier: AI picks a capability first, then a tool within it
 *      - flat:     AI sees all tools at once
 *   4. Return final reasoning text + every tool called for the audit log
 *
 * Catalog nodes are MARKED CONSUMED on the context so the engine BFS skips them.
 */

const BUILT_IN_SAFETY_PROMPT = `You are a Salesforce-embedded AI agent.

Rules:
- Use the provided tool capabilities to gather information and act.
- When the user names an SObject, call describe_sobject before any get/query if you do not already know the field API names.
- When you have enough information to fulfill the instruction, stop calling tools and respond in plain text.
- Be concise. The final response will be stored as the audit reason on the execution record.
- If a tool returns an error, examine it and try a different approach. Do not retry the same call with the same arguments.
- Phase 1 of this product exposes READ-ONLY salesforce tools and STUB write tools for storage/email/channels. Stubs return notes saying they did not actually do anything — treat that as success unless the AI's job requires a real side effect.`;

interface OrchestratorConfig {
  model?: string;
  instruction?: string;
  systemPrompt?: string;
  useKnowledgeBase?: boolean;
  fewShotExamples?: Array<{ input: string; output: string }>;
  dispatchMode?: 'two_tier' | 'flat';
  maxToolCalls?: number;
  captureReasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'max';
  adaptiveThinking?: boolean;
}

interface DiscoveredCatalog {
  catalogNode: AgentNode;
  catalogType: CatalogSubType;
  name: string;
  description: string;
  provider?: string;
  connectorId?: string;
  allowedTools: string[];
  tools: ToolDef[];
}

/** Looks at the AI node's downstream catalogs, marks them consumed, returns their config. */
function discoverCatalogs(node: AgentNode, ctx: ExecutionContext): DiscoveredCatalog[] {
  const downstream = ctx.consumeDownstreamCatalogs(node.id);
  const result: DiscoveredCatalog[] = [];
  for (const c of downstream) {
    const catalogType = c.nodeSubType as CatalogSubType;
    const allowedTools = Array.isArray(c.config?.allowedTools) ? (c.config.allowedTools as string[]) : [];
    if (allowedTools.length === 0) continue;
    const tools = getCatalogTools(catalogType, allowedTools);
    if (tools.length === 0) continue;
    result.push({
      catalogNode: c,
      catalogType,
      name: catalogType.replace(/_tools$/, ''),
      description: (c.config?.description as string) ?? '',
      provider: c.config?.provider as string | undefined,
      connectorId: (c.config?.connectorId as string) || undefined,
      allowedTools,
      tools,
    });
  }
  return result;
}

/** Build the chat messages with cache-friendly layering (KB → safety → admin override → few-shot → instruction + context). */
function buildMessages(ctx: ExecutionContext, config: OrchestratorConfig) {
  const systemParts: string[] = [];
  if (config.useKnowledgeBase !== false && ctx.agent.knowledgeBase) {
    systemParts.push('KNOWLEDGE BASE — Business rules for this agent:\n\n' + ctx.agent.knowledgeBase);
  }
  systemParts.push(BUILT_IN_SAFETY_PROMPT);
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    systemParts.push('ADDITIONAL INSTRUCTIONS:\n' + config.systemPrompt);
  }

  type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };
  const messages: ChatMsg[] = [{ role: 'system', content: systemParts.join('\n\n') }];

  for (const ex of config.fewShotExamples ?? []) {
    if (!ex.input || !ex.output) continue;
    messages.push({ role: 'user', content: ex.input });
    messages.push({ role: 'assistant', content: ex.output });
  }

  const instruction = ctx.interpolate(config.instruction || '').trim();
  const contextBlock = buildContextBlock(ctx);
  messages.push({
    role: 'user',
    content: instruction
      ? `${instruction}\n\nContext:\n${contextBlock}`
      : `Decide what to do based on the context.\n\nContext:\n${contextBlock}`,
  });

  return messages;
}

function buildContextBlock(ctx: ExecutionContext): string {
  const parts: string[] = [];
  parts.push(`Trigger record ID: ${ctx.recordId}`);
  if (Object.keys(ctx.inputPayload).length > 0) {
    parts.push(`Trigger payload:\n${JSON.stringify(ctx.inputPayload, null, 2)}`);
  }
  if (ctx.state.size > 0) {
    const upstream: Record<string, unknown> = {};
    for (const [nodeId, out] of ctx.state.entries()) upstream[nodeId] = out;
    parts.push(`Upstream node outputs:\n${JSON.stringify(upstream, null, 2).slice(0, 4000)}`);
  }
  return parts.join('\n\n');
}

// ── GPT (OpenAI) orchestrator ─────────────────────────────────────────

const gpt4Exec: NodeExecutor = async (node, ctx) => {
  const config = (node.config as OrchestratorConfig) || {};
  const model = config.model || 'gpt-4o';
  const dispatchMode = config.dispatchMode || 'two_tier';
  const maxIterations = Math.min(Math.max(Number(config.maxToolCalls ?? 12), 1), 50);

  const catalogs = discoverCatalogs(node, ctx);
  const messages = buildMessages(ctx, config);

  // No catalogs attached → degrade to plain Claude/GPT-style scoring call
  if (catalogs.length === 0) {
    try {
      const result = await callOpenAi({
        model,
        systemPrompt: config.systemPrompt || '',
        knowledgeBase: config.useKnowledgeBase !== false ? ctx.agent.knowledgeBase : undefined,
        userMessage: ctx.interpolate(config.instruction || '') || 'Score the trigger payload.',
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });
      return {
        nodeId: node.id,
        nodeSubType: 'gpt4',
        success: true,
        output: { finalText: result.text, score: result.score, priority: result.priority, reason: result.reason },
        score: result.score,
        priority: result.priority,
        reason: config.captureReasoning !== false ? result.text : result.reason,
        toolsUsed: result.toolsUsed,
      };
    } catch (err) {
      logger.error({ err, nodeId: node.id }, 'gpt4_node_failed');
      return { nodeId: node.id, nodeSubType: 'gpt4', success: false, error: (err as Error).message };
    }
  }

  // Catalogs attached → run orchestrator loop
  try {
    if (dispatchMode === 'two_tier') {
      const twoTierCatalogs: CatalogForTwoTier[] = catalogs.map((c) => ({
        name: c.name,
        description: c.description,
        tools: c.tools,
        catalogContext: { catalogType: c.catalogType, provider: c.provider, connectorId: c.connectorId },
      }));

      const result = await runTwoTierLoop({
        model,
        initialMessages: messages as unknown as Parameters<typeof runTwoTierLoop>[0]['initialMessages'],
        catalogs: twoTierCatalogs,
        dispatch: async (catalog, toolName, input) => {
          const ctxObj = catalog.catalogContext as { catalogType: CatalogSubType; provider?: string; connectorId?: string };
          return dispatchTool({
            catalogType: ctxObj.catalogType,
            toolName,
            toolInput: input,
            provider: ctxObj.provider,
            connectorId: ctxObj.connectorId,
          });
        },
        maxIterations,
      });

      return buildOrchResult(node, 'gpt4', config, result.finalText, result.toolCalls, {
        reasoningTrace: result.reasoningTrace,
        iterations: result.iterations,
        stoppedReason: result.stoppedReason,
        dispatchMode: 'two_tier',
      });
    }

    // FLAT dispatch — all tools merged into one list
    const flatTools: OpenAiTool[] = catalogs.flatMap((c) => c.tools);
    const result = await callOpenAiWithTools({
      model,
      messages: messages as unknown as Parameters<typeof callOpenAiWithTools>[0]['messages'],
      tools: flatTools,
      dispatch: async (toolName, input) => {
        // In flat mode we don't know which catalog the AI is in — find by tool name
        const owning = catalogs.find((c) => c.tools.some((t) => t.function.name === toolName));
        if (!owning) throw new Error(`No catalog owns tool ${toolName}`);
        return dispatchTool({
          catalogType: owning.catalogType,
          toolName,
          toolInput: input,
          provider: owning.provider,
          connectorId: owning.connectorId,
        });
      },
      maxIterations,
    });

    return buildOrchResult(node, 'gpt4', config, result.finalText, result.toolCalls, {
      iterations: result.iterations,
      stoppedReason: result.stoppedReason,
      dispatchMode: 'flat',
    });
  } catch (err) {
    logger.error({ err, nodeId: node.id }, 'gpt4_orchestrator_failed');
    return { nodeId: node.id, nodeSubType: 'gpt4', success: false, error: (err as Error).message };
  }
};

register('gpt4', gpt4Exec);

// ── Claude orchestrator ──────────────────────────────────────────────
// Phase 1: works WITHOUT tool catalogs (plain scoring call).
// WITH tool catalogs: returns a clear "not wired for tool use yet" error.
// Phase 2 will add Claude's native tool_use loop + two-tier dispatch.

const claudeExec: NodeExecutor = async (node, ctx) => {
  const config = (node.config as OrchestratorConfig) || {};
  const catalogs = discoverCatalogs(node, ctx);

  if (catalogs.length > 0) {
    return {
      nodeId: node.id,
      nodeSubType: 'claude',
      success: false,
      error:
        'Claude orchestrator with tool catalogs is not yet wired for two-tier dispatch (Phase 2). Use a GPT node for tool orchestration, or remove the downstream catalogs.',
    };
  }

  try {
    const result = await callClaude({
      model: config.model || 'claude-opus-4-7',
      systemPrompt: config.systemPrompt || '',
      knowledgeBase: config.useKnowledgeBase !== false ? ctx.agent.knowledgeBase : undefined,
      userMessage: ctx.interpolate(config.instruction || '') || 'Score the trigger payload.',
      effort: config.effort ?? 'high',
      adaptiveThinking: config.adaptiveThinking !== false,
      maxTokens: config.maxTokens,
    });

    return {
      nodeId: node.id,
      nodeSubType: 'claude',
      success: true,
      output: { finalText: result.text, score: result.score, priority: result.priority, reason: result.reason },
      score: result.score,
      priority: result.priority,
      reason: config.captureReasoning !== false ? result.text : result.reason,
      toolsUsed: result.toolsUsed,
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id }, 'claude_node_failed');
    return { nodeId: node.id, nodeSubType: 'claude', success: false, error: (err as Error).message };
  }
};

register('claude', claudeExec);

// ── Gemini orchestrator ──────────────────────────────────────────────
// Same Phase 1 pattern as Claude.

const geminiExec: NodeExecutor = async (node, ctx) => {
  const config = (node.config as OrchestratorConfig) || {};
  const catalogs = discoverCatalogs(node, ctx);

  if (catalogs.length > 0) {
    return {
      nodeId: node.id,
      nodeSubType: 'gemini',
      success: false,
      error:
        'Gemini orchestrator with tool catalogs is not yet wired for two-tier dispatch (Phase 2). Use a GPT node for tool orchestration, or remove the downstream catalogs.',
    };
  }

  try {
    const result = await callGemini({
      model: config.model || 'gemini-2.5-flash',
      systemPrompt: config.systemPrompt || '',
      knowledgeBase: config.useKnowledgeBase !== false ? ctx.agent.knowledgeBase : undefined,
      userMessage: ctx.interpolate(config.instruction || '') || 'Score the trigger payload.',
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });

    return {
      nodeId: node.id,
      nodeSubType: 'gemini',
      success: true,
      output: { finalText: result.text, score: result.score, priority: result.priority, reason: result.reason },
      score: result.score,
      priority: result.priority,
      reason: config.captureReasoning !== false ? result.text : result.reason,
      toolsUsed: result.toolsUsed,
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id }, 'gemini_node_failed');
    return { nodeId: node.id, nodeSubType: 'gemini', success: false, error: (err as Error).message };
  }
};

register('gemini', geminiExec);

// ── Placeholders for less-used AI sub-types ─────────────────────────

register('einstein', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'einstein',
  success: false,
  error: 'Einstein node — Salesforce Einstein API not wired yet.',
}));

register('sentiment', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'sentiment',
  success: false,
  error: 'Sentiment node — provider not wired yet.',
}));

register('embed', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'embed',
  success: false,
  error: 'Embed node — provider not wired yet.',
}));

// ── Helpers ─────────────────────────────────────────────────────────

function buildOrchResult(
  node: AgentNode,
  subType: string,
  config: OrchestratorConfig,
  finalText: string,
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output?: unknown; success: boolean; error?: string }>,
  meta: Record<string, unknown>,
): NodeResult {
  const toolsUsedList = toolCalls.map((c) => `${c.name}${c.success ? '' : '(err)'}`);
  const reasoningText = (meta.reasoningTrace as Array<{ text: string }> | undefined)
    ?.map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');

  // Combine chain-of-thought + final summary for the audit reason
  const audit = config.captureReasoning !== false
    ? [reasoningText, finalText].filter(Boolean).join('\n\n---\n\n')
    : finalText;

  logger.info(
    {
      nodeId: node.id,
      subType,
      toolCallCount: toolCalls.length,
      dispatchMode: meta.dispatchMode,
      iterations: meta.iterations,
    },
    'ai_orchestrator_complete',
  );

  return {
    nodeId: node.id,
    nodeSubType: subType,
    success: true,
    output: {
      finalText,
      toolCalls,
      ...meta,
    },
    toolsUsed: toolsUsedList,
    reason: audit,
  };
}
