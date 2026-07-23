/**
 * Durable-run resume API — sessionAuth, org-scoped.
 *
 * Approvals call this via AgentApprovalController.decide(); the poller
 * (scheduler/run-poller.ts) calls resumeRunById directly in-process for
 * waits (no HTTP round trip needed there).
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { resumeRunById } from '../orchestrator/engine';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { RunsRepo } from '../db/runs.repo';
import type { AgentExecuteResponse } from '../types';

export const runsRouter = Router();

const resumeSchema = z.object({
  runId: z.string().min(1).optional(),
  approvalToken: z.string().min(1).optional(),
  decision: z.enum(['approved', 'rejected']).optional(),
}).refine((d) => !!d.runId || !!d.approvalToken, { message: 'runId or approvalToken required' });

runsRouter.post('/api/agent/runs/resume', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = resumeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const { approvalToken, decision } = parsed.data;

  try {
    let runId = parsed.data.runId;
    if (!runId && approvalToken) {
      const run = await RunsRepo.getByApprovalToken(approvalToken);
      if (!run || run.orgId !== orgId) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      runId = run.id;
    }
    if (!runId) {
      res.status(400).json({ error: 'run_not_found' });
      return;
    }

    const run = await RunsRepo.getById(orgId, runId);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (run.status === 'WAITING_APPROVAL' && !decision) {
      res.status(400).json({ error: 'decision_required', message: 'decision must be "approved" or "rejected" to resume an approval-paused run.' });
      return;
    }

    const conn = await getOrgConnection(orgId);
    const agent = await AgentCache.load(orgId, run.agentApiName, conn);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found', agentApiName: run.agentApiName });
      return;
    }

    const result = await resumeRunById({ orgId, runId: run.id, agent, conn, decision });
    const response: AgentExecuteResponse = {
      success: result.success,
      correlationId: result.correlationId,
      agentScore: result.agentScore,
      agentPriority: result.agentPriority,
      agentReason: result.agentReason,
      agentStatus: result.agentStatus,
      agentOutputPayload: JSON.stringify(result.agentOutputPayload),
      toolsUsed: result.toolsUsed.join(','),
      runId: result.runId,
    };
    res.json(response);
  } catch (err) {
    logger.error({ err, orgId }, 'run_resume_failed');
    res.status(500).json({ error: 'resume_failed', message: (err as Error).message });
  }
});
