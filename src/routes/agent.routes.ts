import { Router } from 'express';
import { z } from 'zod';
import { jwtAuth } from '../auth/jwt';
import { logger } from '../logger';
import { runAgent } from '../orchestrator/engine';
import { loadAgentDefinition } from '../salesforce/client';
import { schedulePlatformEvent } from '../salesforce/callback';
import type { AgentExecuteRequest, AgentExecuteResponse } from '../types';

export const agentRouter = Router();

const executeSchema = z.object({
  agentApiName: z.string().min(1),
  recordId: z.string().min(1),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  runMode: z.enum(['sync', 'async']).default('sync'),
  inputPayload: z.record(z.unknown()).default({}),
  department: z.string().optional(),
});

agentRouter.post('/agent/execute', jwtAuth, async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const request: AgentExecuteRequest = parsed.data;
  const traceLogger = logger.child({ agentApiName: request.agentApiName, recordId: request.recordId });

  try {
    const agent = await loadAgentDefinition(request.agentApiName);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found', agentApiName: request.agentApiName });
      return;
    }
    if (agent.status !== 'Active') {
      res.status(409).json({ error: 'agent_not_active', status: agent.status });
      return;
    }

    if (request.runMode === 'async') {
      // Acknowledge immediately, run in background, push result via Platform Event.
      const correlationId = `async-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ack: AgentExecuteResponse = {
        success: true,
        correlationId,
        agentStatus: 'QUEUED',
      };
      res.status(202).json(ack);

      // Fire-and-forget
      runAgent({ agent, request })
        .then((result) => {
          traceLogger.info({ correlationId: result.correlationId, durationMs: result.durationMs }, 'async_run_complete');
          return schedulePlatformEvent({
            agentApiName: request.agentApiName,
            recordId: request.recordId,
            result,
          });
        })
        .catch((err) => {
          traceLogger.error({ err }, 'async_run_failed');
        });
      return;
    }

    // Sync path
    const result = await runAgent({ agent, request });
    const response: AgentExecuteResponse = {
      success: result.success,
      correlationId: result.correlationId,
      agentScore: result.agentScore,
      agentPriority: result.agentPriority,
      agentReason: result.agentReason,
      agentStatus: result.agentStatus,
      agentOutputPayload: JSON.stringify(result.agentOutputPayload),
      toolsUsed: result.toolsUsed.join(','),
    };
    res.json(response);
  } catch (err) {
    traceLogger.error({ err }, 'execute_failed');
    res.status(500).json({ error: 'execution_failed', message: (err as Error).message });
  }
});

/**
 * Status lookup — for async runs, SF polls this with the correlationId
 * until the Platform Event lands. Keeps the API simple if a customer
 * can't subscribe to platform events.
 */
agentRouter.get('/agent/status/:correlationId', jwtAuth, async (req, res) => {
  // In a real system this would query a result store (Redis/postgres).
  // MVP: tell the caller to subscribe to AgentExecutionResult__e instead.
  res.json({
    correlationId: req.params.correlationId,
    note: 'For async results subscribe to the AgentExecutionResult__e Platform Event in Salesforce.',
  });
});
