/**
 * chat-engine — dispatcher that routes each chat turn to the right
 * provider adapter based on the agent's AI node sub-type.
 *
 * Also fires the auto session title generator off-thread after turn 3
 * so the sidebar shows a meaningful title instead of the user's greeting.
 */
import { logger } from '../logger';
import type { AgentDefinition, AgentNode } from '../types';
import { runClaudeAdapter } from './adapters/claude';
import { runOpenAiAdapter } from './adapters/openai';
import { generateSessionTitleAsync } from './title-generator';
import type { ChatTurnRequest, ChatTurnResult } from './adapters/types';

export type { ChatTurnRequest, ChatTurnResult, ChatHistoryMessage } from './adapters/types';

const TITLE_TRIGGER_TURN = 3;

export async function runChatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
  const aiNode = findAiNode(req.agent);
  if (!aiNode) throw new Error('Agent has no AI orchestrator node — cannot run chat mode.');

  logger.info({
    orgId: req.context.orgId,
    agentApiName: req.agent.apiName,
    aiNodeSubType: aiNode.nodeSubType,
  }, 'chat_turn_dispatch');

  let result: ChatTurnResult;
  switch (aiNode.nodeSubType) {
    case 'claude':
      result = await runClaudeAdapter(req, aiNode);
      break;
    case 'gpt4':
      result = await runOpenAiAdapter(req, aiNode);
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

  // Fire-and-forget: after turn 3, generate a proper title in the background.
  // Uses the SAME engine as the agent's AI node, but with the cheapest model
  // for that provider — one API bill, minimal cost, always available.
  const turnCount = countUserTurns(req.history) + 1;
  if (turnCount === TITLE_TRIGGER_TURN && result.assistantText) {
    const engineType = normalizeEngineType(aiNode.nodeSubType);
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
