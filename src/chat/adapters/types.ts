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
}

export interface EngineOverrideInput {
  engineType?:   string;
  apiKey?:       string;
  endpoint?:     string;
  defaultModel?: string;
  connectionId?: string;
}

export interface ChatTurnRequest {
  agent: AgentDefinition;
  sessionId: string;
  history: ChatHistoryMessage[];
  newUserMessage: string;
  attachments?: AttachmentInput[];
  engineOverride?: EngineOverrideInput;
  connectors?: ConnectorInput[];
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
}

export interface ChatTurnResult {
  status: 'complete';
  assistantText: string;
  toolCalls: ToolCallSummary[];
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
}
