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
import { extractTextFromUpload } from '../kb/file-extract';

export const agentGeneratorRouter = Router();

const requestSchema = z
  .object({
    requirementText: z.string().default(''),
    fileBase64: z.string().optional(),
    fileName: z.string().optional(),
    qaHistory: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
    /** Defaults to 'trigger' to match AgentDefinition__c.ExecuteType__c's own field default. */
    mode: z.enum(['trigger', 'chat']).default('trigger'),
    engineOverride: z.object({
      engineType:   z.string().nullish(),
      apiKey:       z.string().nullish(),
      endpoint:     z.string().nullish(),
      defaultModel: z.string().nullish(),
      connectionId: z.string().nullish(),
    }).optional(),
  })
  // Text, a document, or dictated-then-transcribed voice all land in
  // requirementText client-side (see agent-generator-data.ts) — a file is
  // the one genuinely separate input, so at least one of the two is
  // required, not both.
  .refine((v) => v.requirementText.trim().length > 0 || Boolean(v.fileBase64), {
    message: 'Provide a requirement description and/or upload a document.',
  });

agentGeneratorRouter.post('/api/agent/generate', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const { fileBase64, fileName, qaHistory, engineOverride, mode } = parsed.data;

  try {
    // Real PDF parsing (not a naive base64->utf8 decode, which produces
    // binary noise for anything but plain text) — same extractor the KB
    // upload pipeline already uses, so a real requirement document
    // (spec.pdf, a process doc) reads correctly here too.
    const fileText = fileBase64 ? await extractTextFromUpload(fileBase64, fileName ?? null) : '';
    const requirementText = [parsed.data.requirementText, fileText].filter(Boolean).join('\n\n');

    const result = await generateAgent(
      { orgId, requirementText, qaHistory: qaHistory as QaTurn[], mode },
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
