/**
 * chat-engine — dispatcher that routes each chat turn to the right
 * provider adapter based on the agent's AI node sub-type.
 *
 * Also handles Topic classification + Action resolution before dispatch:
 * a cheap model call (when the agent has 2+ Topics) picks the active one,
 * whose attached Actions get merged into the connector payload the SAME
 * way a catalog node's own customTools/allowedTools already work — no new
 * execution path, just more entries in an existing, proven mechanism.
 *
 * Also fires the auto session title generator off-thread after turn 3
 * so the sidebar shows a meaningful title instead of the user's greeting.
 */
import { logger } from '../logger';
import type { AgentDefinition, AgentNode, AgentAction, AgentTopic } from '../types';
import { runClaudeAdapter } from './adapters/claude';
import { runOpenAiAdapter } from './adapters/openai';
import { generateSessionTitleAsync } from './title-generator';
import { classifyTopic } from './topic-router';
import type { ChatTurnRequest, ChatTurnResult, ConnectorInput } from './adapters/types';

export type { ChatTurnRequest, ChatTurnResult, ChatHistoryMessage } from './adapters/types';

const TITLE_TRIGGER_TURN = 3;

export async function runChatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
  const aiNode = findAiNode(req.agent);
  if (!aiNode) throw new Error('Agent has no AI orchestrator node — cannot run chat mode.');

  const engineType = normalizeEngineType(aiNode.nodeSubType);

  logger.info({
    orgId: req.context.orgId,
    agentApiName: req.agent.apiName,
    aiNodeSubType: aiNode.nodeSubType,
    topicCount: req.agent.topics.length,
  }, 'chat_turn_dispatch');

  // Topic classification + Action resolution — only meaningful for engines
  // chat mode actually supports (claude/gpt4). Gemini/unknown falls through
  // to the existing error below with no topic work wasted first.
  let activeTopic: AgentTopic | null = null;
  if (engineType === 'claude' || engineType === 'openai') {
    activeTopic = await classifyTopic({
      engineType,
      topics: req.agent.topics,
      history: req.history,
      newUserMessage: req.newUserMessage,
      previousTopicName: req.previousTopicName,
      engineOverride: req.engineOverride,
    });
  }

  const availableActions = resolveAvailableActions(req.agent, activeTopic);
  const turnReq: ChatTurnRequest = {
    ...req,
    activeTopic: activeTopic ? { name: activeTopic.name, instructions: activeTopic.instructions } : null,
    connectors: mergeActionsIntoConnectors(req.connectors, availableActions),
  };

  let result: ChatTurnResult;
  switch (aiNode.nodeSubType) {
    case 'claude':
      result = await runClaudeAdapter(turnReq, aiNode);
      break;
    case 'gpt4':
      result = await runOpenAiAdapter(turnReq, aiNode);
      break;
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

  result.activeTopicName = activeTopic?.name ?? null;

  // Fire-and-forget: after turn 3, generate a proper title in the background.
  // Uses the SAME engine as the agent's AI node, but with the cheapest model
  // for that provider — one API bill, minimal cost, always available.
  const turnCount = countUserTurns(req.history) + 1;
  if (turnCount === TITLE_TRIGGER_TURN && result.assistantText) {
    if (engineType) {
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
  }

  return result;
}

/**
 * Which Actions apply this turn. Zero enabled Topics (none defined, or all
 * disabled) means no routing is happening at all, so the WHOLE enabled
 * library applies — same "skip complexity when there's nothing to route"
 * fallback classifyTopic itself uses. Otherwise, only the classified
 * Topic's attached Actions apply.
 */
function resolveAvailableActions(agent: AgentDefinition, activeTopic: AgentTopic | null): AgentAction[] {
  const enabledById = new Map(agent.actions.filter(a => a.isEnabled).map(a => [a.id, a]));
  const hasEnabledTopics = agent.topics.some(t => t.isEnabled);
  if (!hasEnabledTopics) return [...enabledById.values()];
  if (!activeTopic) return [];
  return activeTopic.actionIds
    .map(id => enabledById.get(id))
    .filter((a): a is AgentAction => !!a);
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
