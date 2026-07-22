import { randomUUID } from 'crypto';
import type { Connection } from 'jsforce';
import { ExecutionContext } from './context';
import { buildGraph, findTrigger, nextNodes } from './graph';
import { getExecutor, echoExecutor } from '../nodes/registry';
import { logger } from '../logger';
import type { AgentDefinition, AgentExecuteRequest, AgentNode, GraphResult, NodeResult } from '../types';

// Side-effect imports — registers all node executors
import '../nodes/trigger';
import '../nodes/logic';
import '../nodes/end';
import '../nodes/ai';
import '../nodes/action';
import '../nodes/channel';
import '../nodes/tool-catalogs';

const MAX_NODES_PER_RUN = 100; // safety cap

export async function runAgent(args: {
  agent: AgentDefinition;
  request: AgentExecuteRequest;
  conn: Connection;
}): Promise<GraphResult> {
  const { agent, request, conn } = args;
  const correlationId = randomUUID();
  const start = Date.now();

  const ctx = new ExecutionContext({
    correlationId,
    agent,
    recordId: request.recordId,
    orgId: request.orgId,
    userId: request.userId,
    inputPayload: request.inputPayload,
    conn,
  });

  const graph = buildGraph(agent);
  ctx.graph = graph; // AI orchestrator executors read this to find downstream catalogs
  const trigger = findTrigger(graph);
  if (!trigger) {
    return errorResult(correlationId, start, 'No trigger node found in agent definition');
  }

  let lastAiResult: NodeResult | undefined;
  let lastError: string | undefined;
  let nodesRun = 0;

  // Iterative BFS, branching by port
  const queue: AgentNode[] = [trigger];
  const visited = new Set<string>();

  while (queue.length > 0) {
    if (nodesRun >= MAX_NODES_PER_RUN) {
      lastError = `Hit MAX_NODES_PER_RUN (${MAX_NODES_PER_RUN}) — likely a loop in the graph`;
      break;
    }

    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    if (!node.isEnabled) continue;
    // Skip catalog nodes that were already consumed by an upstream AI orchestrator
    if (node.nodeType === 'catalog' && ctx.consumedCatalogIds.has(node.id)) continue;

    const executor = getExecutor(node.nodeSubType) ?? echoExecutor;
    let result: NodeResult;
    try {
      result = await executor(node, ctx);
    } catch (err) {
      logger.error({ err, nodeId: node.id, subType: node.nodeSubType }, 'node_executor_threw');
      result = {
        nodeId: node.id,
        nodeSubType: node.nodeSubType,
        success: false,
        error: (err as Error).message,
      };
    }

    nodesRun++;
    ctx.recordResult(node, result);

    if (!result.success) {
      lastError = result.error ?? 'unknown error';
      break;
    }
    if (node.nodeType === 'ai') lastAiResult = result;

    // Branch on if/else: only follow the matching port
    const port = result.nextPort ?? 'out';
    const downstream = nextNodes(graph, node.id, port);
    for (const next of downstream) {
      // If we just ran an AI orchestrator and the next node is a catalog it consumed,
      // skip the catalog and continue past it (anything connected after the catalog runs normally).
      if (next.nodeType === 'catalog' && ctx.consumedCatalogIds.has(next.id)) {
        queue.push(...nextNodes(graph, next.id, 'out'));
      } else {
        queue.push(next);
      }
    }
  }

  const durationMs = Date.now() - start;
  const success = !lastError;

  return {
    success,
    correlationId,
    agentStatus: success ? 'SUCCESS' : 'ERROR',
    agentScore: lastAiResult?.score,
    agentPriority: lastAiResult?.priority,
    agentReason: lastError ?? lastAiResult?.reason,
    agentOutputPayload: Object.fromEntries(
      // Flatten last result of each node type for SF consumers
      Array.from(ctx.state.entries()).map(([id, out]) => [id, out]),
    ),
    toolsUsed: Array.from(ctx.toolsUsed),
    durationMs,
  };
}

function errorResult(correlationId: string, start: number, reason: string): GraphResult {
  return {
    success: false,
    correlationId,
    agentStatus: 'ERROR',
    agentReason: reason,
    agentOutputPayload: {},
    toolsUsed: [],
    durationMs: Date.now() - start,
  };
}
