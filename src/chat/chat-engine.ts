/**
 * chat-engine — dispatcher that routes each chat turn to the right
 * provider adapter based on the agent's AI node sub-type.
 *
 * Subagent routing (replaces the old Topic-classifier model): the top-level
 * adapter call sees the agent's directly-attached 'tool' nodes AND a
 * handoff tool declaration for each directly-attached 'subagent' node, all
 * in the SAME request — the model's own function-calling reasoning picks
 * between answering directly, calling a plain tool, or handing off. When it
 * hands off, a SECOND adapter call runs as that subagent's own turn (its
 * own systemPrompt/model/tools), and THAT result becomes the turn's real
 * output. See subagent-router.ts for how the graph is resolved into tool
 * lists, and claude.ts/openai.ts for how a handoff selection is detected.
 *
 * An agent with no subagent/tool graph nodes (never migrated, or never had
 * any) behaves exactly as before this rewrite — resolveTopLevelToolsAndSubagents
 * returns empty lists, so no extra tool defs are added and no second call
 * ever happens.
 *
 * Also fires the auto session title generator off-thread after turn 3
 * so the sidebar shows a meaningful title instead of the user's greeting.
 */
import { logger } from '../logger';
import type { AgentDefinition, AgentNode, AgentAction } from '../types';
import { runClaudeAdapter } from './adapters/claude';
import { runOpenAiAdapter } from './adapters/openai';
import { generateSessionTitleAsync } from './title-generator';
import { buildGraph } from '../orchestrator/graph';
import { resolveTopLevelToolsAndSubagents, resolveSubagentActions, toSyntheticAiNode, type HandoffToolDef } from './subagent-router';
import type { ChatTurnRequest, ChatTurnResult, ConnectorInput } from './adapters/types';

export type { ChatTurnRequest, ChatTurnResult, ChatHistoryMessage } from './adapters/types';

const TITLE_TRIGGER_TURN = 3;

export async function runChatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
  const aiNode = findAiNode(req.agent);
  if (!aiNode) throw new Error('Agent has no AI orchestrator node — cannot run chat mode.');

  const graph = buildGraph(req.agent);
  const { topLevelActions, handoffTools } = resolveTopLevelToolsAndSubagents(req.agent, graph, aiNode);

  logger.info({
    orgId: req.context.orgId,
    agentApiName: req.agent.apiName,
    aiNodeSubType: aiNode.nodeSubType,
    topLevelActionCount: topLevelActions.length,
    subagentCount: handoffTools.length,
  }, 'chat_turn_dispatch');

  const turnReq: ChatTurnRequest = {
    ...req,
    activeTopic: null,
    connectors: mergeActionsIntoConnectors(req.connectors, topLevelActions),
  };

  let result = await dispatchToAdapter(aiNode, turnReq, handoffTools);
  let finalAiNode = aiNode;

  let activeSubagentName: string | null = null;
  if (result.handoffSubagentNodeId) {
    const subagentNode = graph.byId.get(result.handoffSubagentNodeId);
    if (!subagentNode) {
      // Defensive only — the handoff tool name is built FROM this node id,
      // so this would mean the graph changed mid-turn. Don't throw; fall
      // through with the (empty) top-level result rather than breaking an
      // in-progress conversation over a race that shouldn't happen.
      logger.error({ orgId: req.context.orgId, nodeId: result.handoffSubagentNodeId }, 'chat_engine_handoff_target_missing');
    } else {
      activeSubagentName = subagentNode.name;
      const subagentAiNode = toSyntheticAiNode(subagentNode, aiNode);
      const subagentActions = resolveSubagentActions(graph, subagentNode);
      const subagentReq: ChatTurnRequest = {
        ...req,
        activeTopic: null,
        connectors: mergeActionsIntoConnectors(req.connectors, subagentActions),
      };

      logger.info({
        orgId: req.context.orgId,
        subagentNodeId: subagentNode.id,
        subagentName: subagentNode.name,
        subagentActionCount: subagentActions.length,
      }, 'chat_engine_subagent_dispatch');

      // No handoffTools passed here — hard 2-tier depth cap (see
      // subagent-router.ts's module doc for why this alone is sufficient).
      //
      // try/catch is deliberate: by this point the TOP-LEVEL call already
      // succeeded and was really billed (real tokensIn/tokensOut sitting in
      // `result`). If the subagent's own call throws — a transient provider
      // error, or a cross-provider credential mismatch (see
      // subagent-router.ts's KNOWN LIMITATION doc) — letting that exception
      // escape runChatTurn would 500 the whole turn, which does two bad
      // things at once: shows the customer nothing instead of a real reply,
      // and (worse) makes Apex's error path insert a ChatMessage__c with no
      // TokensIn__c/TokensOut__c set at all — silently erasing the top-level
      // call's real spend from AgentGuardrailsController's cap tracking.
      // Degrading here preserves both: a real reply to the customer, and
      // `result`'s already-correct token counts.
      let subResult: ChatTurnResult;
      try {
        subResult = await dispatchToAdapter(subagentAiNode, subagentReq, []);
      } catch (err) {
        logger.error({
          orgId: req.context.orgId,
          subagentNodeId: subagentNode.id,
          err: err instanceof Error ? err.message : err,
        }, 'chat_engine_subagent_dispatch_failed');
        result.assistantText = "Sorry, I couldn't complete that just now — could you try again in a moment?";
        result.toolCalls = [];
        if (activeSubagentName !== null) result.activeTopicName = activeSubagentName;
        return result; // tokensIn/tokensOut from the successful top-level call are preserved as-is
      }
      finalAiNode = subagentAiNode;
      result = {
        ...subResult,
        tokensIn:  result.tokensIn  + subResult.tokensIn,
        tokensOut: result.tokensOut + subResult.tokensOut,
        // The spread above would otherwise silently replace the top-level
        // call's debugRequest/debugResponse with only the subagent's —
        // ChatTurnResult's own contract is "one entry per provider call
        // this turn," so concatenate rather than clobber.
        debugRequest: req.debugMode
          ? [...(result.debugRequest ?? []), ...(subResult.debugRequest ?? [])]
          : undefined,
        debugResponse: req.debugMode
          ? [...(result.debugResponse ?? []), ...(subResult.debugResponse ?? [])]
          : undefined,
      };
    }
  }

  // Only set when there's an actual subagent to report — leaving the key
  // genuinely ABSENT (not present-as-null) when there's no handoff matches
  // pre-existing behavior and keeps Apex's `body.containsKey('activeTopicName')`
  // gate meaningful (AgentChatController.cls only persists ActiveTopic__c
  // when this key is present at all).
  if (activeSubagentName !== null) {
    result.activeTopicName = activeSubagentName;
  }

  // Fire-and-forget: after turn 3, generate a proper title in the background.
  // Uses whichever engine actually produced the FINAL reply this turn (the
  // subagent's, if a handoff happened) — cheapest model for that provider.
  const engineType = normalizeEngineType(finalAiNode.nodeSubType);
  const turnCount = countUserTurns(req.history) + 1;
  if (turnCount === TITLE_TRIGGER_TURN && result.assistantText && engineType) {
    generateSessionTitleAsync({
      orgId:               req.context.orgId,
      sessionId:           req.sessionId,
      engineType,
      history:             req.history,
      newUserMessage:      req.newUserMessage,
      newAssistantMessage: result.assistantText,
      engineOverride:      req.engineOverride,
    });
  }

  return result;
}

async function dispatchToAdapter(
  aiNode: AgentNode,
  turnReq: ChatTurnRequest,
  handoffTools: HandoffToolDef[],
): Promise<ChatTurnResult> {
  switch (aiNode.nodeSubType) {
    case 'claude':
      return runClaudeAdapter(turnReq, aiNode, handoffTools);
    case 'gpt4':
      return runOpenAiAdapter(turnReq, aiNode, handoffTools);
    case 'gemini':
      throw new Error(
        'Gemini adapter is not implemented yet. Use a Claude or GPT node on this agent for chat mode.',
      );
    default:
      throw new Error(
        `Chat mode does not support AI node sub-type "${aiNode.nodeSubType}". ` +
        `Use claude or gpt4 (Gemini support coming later).`,
      );
  }
}

/**
 * Fold resolved Actions into the salesforce_mcp connector entry Apex
 * already sends — MCP-type actions extend allowedTools, Apex/Flow-type
 * extend customTools, the SAME fields a catalog node's own tool picker
 * already populates (see AgentChatController.buildConnectorsPayload /
 * connectors-from-agent.ts). No new execution path.
 */
function mergeActionsIntoConnectors(
  connectors: ConnectorInput[] | undefined,
  actions: AgentAction[],
): ConnectorInput[] | undefined {
  if (actions.length === 0 || !connectors) return connectors;
  const sfIndex = connectors.findIndex(c => c.provider === 'salesforce_mcp');
  if (sfIndex === -1) return connectors; // no Salesforce connector to attach to

  const list = connectors.map(c => ({ ...c, allowedTools: [...c.allowedTools], customTools: c.customTools ? [...c.customTools] : [] }));
  const sf = list[sfIndex];

  for (const action of actions) {
    if (action.actionType === 'MCP') {
      // Empty allowedTools already means "expose every tool" — appending
      // to it would flip that to a hard restriction. Only extend an
      // ALREADY-restricted list; an unrestricted one already covers this.
      if (sf.allowedTools.length > 0 && !sf.allowedTools.includes(action.toolName)) {
        sf.allowedTools.push(action.toolName);
      }
      continue;
    }
    const type = action.actionType === 'Apex' ? 'apex' : 'flow';
    if (!sf.customTools!.some(t => t.type === type && t.name === action.toolName)) {
      sf.customTools!.push({ type, name: action.toolName, label: action.name });
    }
  }
  return list;
}

function findAiNode(agent: AgentDefinition): AgentNode | null {
  return agent.nodes.find(n => n.nodeType === 'ai') ?? null;
}

function countUserTurns(history: ChatTurnRequest['history']): number {
  return history.filter(m => m.role === 'user').length;
}

/** Map the canvas AI node's subType ('claude'|'gpt4'|'gemini') to the provider key. */
function normalizeEngineType(subType: string): 'claude' | 'openai' | 'gemini' | null {
  if (subType === 'claude') return 'claude';
  if (subType === 'gpt4')   return 'openai';
  if (subType === 'gemini') return 'gemini';
  return null;
}
