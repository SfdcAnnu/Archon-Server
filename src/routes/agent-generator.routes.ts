/**
 * AI agent generation — sessionAuth, org-scoped. Turns a plain-English
 * requirement (+ optional Q&A round-trip) into a canvas-ready agent graph.
 * See server/src/agent-generator/ for the actual generation logic.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { generateAgent } from '../agent-generator/generate';
import type { QaTurn } from '../agent-generator/generate';

export const agentGeneratorRouter = Router();

const requestSchema = z.object({
  requirementText: z.string().min(1),
  fileBase64: z.string().optional(),
  qaHistory: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  engineOverride: z.object({
    engineType:   z.string().optional(),
    apiKey:       z.string().optional(),
    endpoint:     z.string().optional(),
    defaultModel: z.string().optional(),
    connectionId: z.string().optional(),
  }).optional(),
});

agentGeneratorRouter.post('/api/agent/generate', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const { fileBase64, qaHistory, engineOverride } = parsed.data;
  const fileText = fileBase64 ? Buffer.from(fileBase64, 'base64').toString('utf8') : '';
  const requirementText = [parsed.data.requirementText, fileText].filter(Boolean).join('\n\n');

  try {
    const result = await generateAgent(
      { orgId, requirementText, qaHistory: qaHistory as QaTurn[] },
      engineOverride,
    );
    if (result.kind === 'questions') {
      res.json({ kind: 'questions', questions: result.questions });
      return;
    }
    res.json({ kind: 'agent', ...result.agent });
  } catch (err) {
    logger.error({ err, orgId }, 'agent_generate_failed');
    res.status(502).json({ error: 'generate_failed', message: (err as Error).message });
  }
});
