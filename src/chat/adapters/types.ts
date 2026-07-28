/** Shared types across chat adapters. */
import type { AgentDefinition } from '../../types';

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCallsJson?: string | null;
  toolResultsJson?: string | null;
  toolCallId?: string | null;
}

export interface AttachmentInput {
  contentDocumentId: string;
  contentVersionId?: string;   // when present, skips the metadata SOQL lookup
  fileName?:         string;
  mimeType?:         string;
  fileType?:         string;
  fileExtension?:    string;
}

/** Per-connector config sent from Salesforce each turn — SF owns this. */
export interface ConnectorInput {
  provider:     string;          // ConnectorCatalog__mdt DeveloperName, e.g. 'salesforce_mcp'
  mcpServerUrl: string;          // base URL, no /mcp suffix
  allowedTools: string[];        // admin's tool selection; empty = all tools
  connectorId?: string | null;   // Node-side Connector row id (token lookup)
  accessMode?: string | null;    // salesforce_mcp only: 'Org' | 'PerUser'
  customTools?: Array<{ type: string; name: string; label?: string | null }> | null; // org's own Apex actions / Flows
}

export interface EngineOverrideInput {
  engineType?:   string | null;
  apiKey?:       string | null;
  endpoint?:     string | null;
  defaultModel?: string | null;
  connectionId?: string | null;
}

export interface ChatTurnRequest {
  agent: AgentDefinition;
  sessionId: string;
  history: ChatHistoryMessage[];
  newUserMessage: string;
  attachments?: AttachmentInput[];
  engineOverride?: EngineOverrideInput;
  connectors?: ConnectorInput[];
  /** ChatSession__c.ActiveTopic__c from the prior turn — classification bias only. */
  previousTopicName?: string | null;
  /** Set by chat-engine.ts after Topic classification; adapters just thread
   *  it into buildSystemPrompt. Not sent by Apex. */
  activeTopic?: { name: string; instructions: string } | null;
  /** AgentDefinition__c.DebugMode__c — when true, adapters capture the raw
   *  request/response JSON for every provider call this turn (see
   *  ChatTurnResult.debugRequest/debugResponse). Off by default; storing
   *  this on every turn adds real Salesforce field storage, so it's opt-in
   *  per agent, not a global flag. */
  debugMode?: boolean;
  context: {
    orgId: string;
    userId: string;
    recordContextId?: string | null;
    recordContextType?: string | null;
  };
}

export interface ToolCallSummary {
  id:      string;
  name:    string;
  input:   Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  serverName?: string; // which connector/MCP server this call went through
}

/** A tool call the model made outside its connector's configured allowedTools. */
export interface PolicyViolation {
  serverName:   string;
  tool:         string;
  allowedTools: string[];
}

export interface ChatTurnResult {
  status: 'complete';
  assistantText: string;
  toolCalls: ToolCallSummary[];
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  // Only ever populated for adapters that can't hard-block tool calls
  // (Claude's Managed MCP today — see claude.ts). Empty/undefined means
  // either no restriction was configured, or the provider enforces it
  // server-side already (OpenAI).
  policyViolations?: PolicyViolation[];
  /** Set by chat-engine.ts (not the adapters) — the Topic classified for
   *  this turn, if any, so Apex can persist it to ChatSession__c.ActiveTopic__c. */
  activeTopicName?: string | null;
  /** Only populated when ChatTurnRequest.debugMode is true. One entry per
   *  provider call this turn (a narration-only continuation adds a second
   *  round) — Apex stores these verbatim on the assistant ChatMessage__c. */
  debugRequest?: unknown[];
  debugResponse?: unknown[];
}
