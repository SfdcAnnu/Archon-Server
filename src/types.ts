/**
 * Shared types between the SF caller and the server.
 *
 * The request shape mirrors what AgentBuilderController.executeAgent and
 * AgentRunner send. Keep these in sync if you change either side.
 */

export type RunMode = 'sync' | 'async';

/** Mirrors chat/adapters/types.ts EngineOverrideInput — duplicated here
 *  (rather than imported) to avoid a circular dependency, since that file
 *  imports AgentDefinition FROM this one. */
export interface EngineOverrideInput {
  engineType?:   string;
  apiKey?:       string;
  endpoint?:     string;
  defaultModel?: string;
  connectionId?: string;
}

export interface AgentExecuteRequest {
  agentApiName: string;
  recordId: string;
  orgId: string;
  userId: string;
  runMode: RunMode;
  inputPayload: Record<string, unknown>;
  // department is optional context — engine doesn't route on it
  department?: string;
  // Running user's AI Engine Connection key, resolved by Apex — same
  // per-request credential pattern chat already uses.
  engineOverride?: EngineOverrideInput;
}

export interface AgentExecuteResponse {
  success: boolean;
  correlationId: string;
  agentScore?: number;
  agentPriority?: 'Hot' | 'Warm' | 'Cold' | string;
  agentReason?: string;
  agentStatus: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'ERROR' | 'TIMEOUT';
  agentOutputPayload?: string;
  toolsUsed?: string;
}

export interface AgentNode {
  id: string;
  name: string;
  nodeType: string;        // 'trigger' | 'ai' | 'action' | 'logic' | ...
  nodeSubType: string;     // 'claude' | 'get_record' | 'if_else' | ...
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
  sortOrder: number;
  isEnabled: boolean;
  mcpServer?: string | null;
  mcpTool?: string | null;
}

export interface AgentConnection {
  id: string;
  fromIndex: number;
  fromPort: string;        // 'out' | 'yes' | 'no'
  toIndex: number;
  toPort: string;          // 'in'
}

export interface AgentDefinition {
  id: string;
  name: string;
  apiName: string;
  department?: string;
  knowledgeBase?: string;
  status: 'Active' | 'Draft' | 'Inactive';
  /** 'Org' (default) | 'PerUser' — governs Salesforce MCP token selection. */
  accessMode?: string;
  canvasJson?: { connections: AgentConnection[] };
  externalServerUrl?: string;
  nodes: AgentNode[];
}

/** Output produced by a single node execution. */
export interface NodeResult {
  nodeId: string;
  nodeSubType: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
  toolsUsed?: string[];
  // For if/else branching — the executor returns which port to follow next.
  nextPort?: 'out' | 'yes' | 'no';
  // For score-producing nodes (AI) — surfaces into the final response.
  score?: number;
  priority?: string;
  reason?: string;
}

/** Result of running the whole agent graph. */
export interface GraphResult {
  success: boolean;
  correlationId: string;
  agentStatus: AgentExecuteResponse['agentStatus'];
  agentScore?: number;
  agentPriority?: string;
  agentReason?: string;
  agentOutputPayload: Record<string, unknown>;
  toolsUsed: string[];
  durationMs: number;
}
