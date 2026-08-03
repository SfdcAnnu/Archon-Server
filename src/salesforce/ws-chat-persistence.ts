/**
 * Persists WebSocket-path chat turns back to Salesforce (ChatSession__c /
 * ChatMessage__c) — the counterpart to AgentChatController.cls's own
 * startSession()/sendTurn() DML for the HTTP chat path.
 *
 * Why this exists: AgentGuardrailsController.cls's usage totals are
 * computed by SUMMING ChatMessage__c.TokensIn__c/TokensOut__c (see
 * guardrails.ts). If WebSocket turns never wrote any ChatMessage__c rows,
 * their real token spend would be permanently invisible to that sum —
 * the cap could never actually account for React-app usage, regardless of
 * how the pre-turn check in guardrails.ts is wired up. Writing real rows
 * here is what makes the guardrail's accounting complete, not just its
 * enforcement — as a side benefit these sessions also show up in the
 * existing Conversations list (agentHome), same as any other chat.
 *
 * One ChatSession__c is created lazily per WebSocket connection (not per
 * message) and reused for every turn on that connection — mirrored by the
 * caller (ws/gateway.ts) holding the returned id in its own per-connection
 * state.
 */
import type { Connection } from 'jsforce';

const EXPIRY_HOURS = 24; // matches AgentChatController.EXPIRY_HOURS

export async function createWsChatSession(
  conn: Connection,
  agentId: string,
  userId: string,
  department: string | undefined,
): Promise<string> {
  const now = new Date();
  const expires = new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  const result = await conn.sobject('ChatSession__c').create({
    AgentDefinition__c: agentId,
    User__c: userId,
    Status__c: 'Active',
    LastActivityAt__c: now.toISOString(),
    ExpiresAt__c: expires.toISOString(),
    Department__c: department ?? null,
    TotalTurns__c: 0,
    Title__c: 'Canvas test session',
  });
  if (!result.success) {
    throw new Error('Failed to create ChatSession__c for WS turn: ' + JSON.stringify(result));
  }
  return result.id;
}

export async function recordWsTurn(
  conn: Connection,
  sessionId: string,
  seqStart: number,
  userText: string,
  assistantText: string,
  modelUsed: string | undefined,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  await conn.sobject('ChatMessage__c').create([
    {
      ChatSession__c: sessionId,
      Role__c: 'User',
      Content__c: userText,
      SequenceNumber__c: seqStart,
      ApprovalStatus__c: 'NotRequired',
    },
    {
      ChatSession__c: sessionId,
      Role__c: 'Assistant',
      Content__c: assistantText,
      ModelUsed__c: modelUsed ?? null,
      TokensIn__c: tokensIn,
      TokensOut__c: tokensOut,
      SequenceNumber__c: seqStart + 1,
      ApprovalStatus__c: 'NotRequired',
    },
  ]);
  await conn.sobject('ChatSession__c').update({
    Id: sessionId,
    LastActivityAt__c: new Date().toISOString(),
    ExpiresAt__c: new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
  });
}
