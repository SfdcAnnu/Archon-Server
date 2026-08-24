/**
 * Engine testing endpoint.
 *
 *   POST /api/engine/test
 *   Body: { engineType, apiKey, endpoint?, defaultModel? }
 *   → 200 OK if the provider accepts the key with a tiny probe call
 *   → 4xx with { message } if the key/endpoint/model is bad
 *
 * Called by Apex AiEngineConnectionController.testConnection so the LWC
 * "Test Connection" button gives users a definitive yes/no.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';

export const engineRouter = Router();

const testSchema = z.object({
  engineType:   z.enum(['claude', 'openai', 'gemini']),
  apiKey:       z.string().min(10),
  endpoint:     z.string().optional().nullable(),
  defaultModel: z.string().optional().nullable(),
});

engineRouter.post('/api/engine/test', sessionAuth, async (req, res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', message: 'Missing engineType or apiKey.' });
    return;
  }
  const { engineType, apiKey, endpoint, defaultModel } = parsed.data;
  const t0 = Date.now();

  try {
    if (engineType === 'claude') {
      await probeClaude(apiKey, endpoint, defaultModel);
    } else if (engineType === 'openai') {
      await probeOpenAi(apiKey, endpoint, defaultModel);
    } else if (engineType === 'gemini') {
      await probeGemini(apiKey, endpoint, defaultModel);
    }
    logger.info({ engineType, ms: Date.now() - t0 }, 'engine_test_ok');
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Test failed';
    logger.warn({ engineType, ms: Date.now() - t0, err: msg }, 'engine_test_failed');
    res.status(400).json({ error: 'test_failed', message: msg });
  }
});

/**
 * Live model listing.
 *
 *   POST /api/engine/models
 *   Body: { engineType, apiKey, endpoint? }
 *   → { models: string[] }  — chat-capable model ids, newest-ish first
 *
 * Called by Apex AiEngineConnectionController.fetchProviderModels so the
 * AI Models page and the add-connection dialog can offer the provider's
 * REAL current list instead of a hardcoded one. Listing models is free on
 * every provider (no token spend). 'custom' is treated as OpenAI-compatible.
 */
const modelsSchema = z.object({
  engineType: z.enum(['claude', 'openai', 'gemini', 'custom']),
  apiKey:     z.string().min(10),
  endpoint:   z.string().optional().nullable(),
});

engineRouter.post('/api/engine/models', sessionAuth, async (req, res) => {
  const parsed = modelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', message: 'Missing engineType or apiKey.' });
    return;
  }
  const { engineType, apiKey, endpoint } = parsed.data;
  try {
    let models: string[];
    if (engineType === 'claude') {
      models = await listClaudeModels(apiKey, endpoint);
    } else if (engineType === 'gemini') {
      models = await listGeminiModels(apiKey, endpoint);
    } else {
      models = await listOpenAiModels(apiKey, endpoint); // openai + custom (OpenAI-compatible)
    }
    logger.info({ engineType, count: models.length }, 'engine_models_listed');
    res.json({ models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Model listing failed';
    logger.warn({ engineType, err: msg }, 'engine_models_failed');
    res.status(400).json({ error: 'models_failed', message: msg });
  }
});

// Non-chat OpenAI artifacts that /v1/models returns alongside chat models —
// embeddings, audio, image, moderation — which would only clutter a picker
// whose sole job is choosing a conversation model.
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|babbage|davinci|codex|search|sora|video)/i;

async function listOpenAiModels(apiKey: string, endpoint?: string | null): Promise<string[]> {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.openai.com') + '/v1/models';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`OpenAI model listing failed (${res.status}): ${truncate(await res.text(), 300)}`);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? [])
    .map(m => m.id)
    .filter(id => !OPENAI_NON_CHAT.test(id))
    .sort()
    .reverse(); // reverse-alpha floats newer families (gpt-5 > gpt-4) toward the top
}

async function listClaudeModels(apiKey: string, endpoint?: string | null): Promise<string[]> {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.anthropic.com') + '/v1/models?limit=100';
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`Claude model listing failed (${res.status}): ${truncate(await res.text(), 300)}`);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map(m => m.id); // Anthropic already returns newest first
}

async function listGeminiModels(apiKey: string, endpoint?: string | null): Promise<string[]> {
  const base = endpoint?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com';
  const res = await fetch(`${base}/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) throw new Error(`Gemini model listing failed (${res.status}): ${truncate(await res.text(), 300)}`);
  const json = (await res.json()) as {
    models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  };
  return (json.models ?? [])
    .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(id => !/embedding|aqa|imagen/i.test(id));
}

async function probeClaude(apiKey: string, endpoint?: string | null, model?: string | null) {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.anthropic.com') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      model || 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages:   [{ role: 'user', content: 'ping' }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude probe failed (${res.status}): ${truncate(body, 300)}`);
  }
}

async function probeOpenAi(apiKey: string, endpoint?: string | null, model?: string | null) {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.openai.com') + '/v1/models';
  const res = await fetch(url, {
    method:  'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI probe failed (${res.status}): ${truncate(body, 300)}`);
  }
  if (model) {
    // Optional deeper check — model actually exists on this account.
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const found = (json.data || []).some(m => m.id === model);
    if (!found) throw new Error(`Model "${model}" not available to this API key.`);
  }
}

async function probeGemini(apiKey: string, endpoint?: string | null, model?: string | null) {
  const base = endpoint?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com';
  const url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini probe failed (${res.status}): ${truncate(body, 300)}`);
  }
  if (model) {
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    const wanted = model.startsWith('models/') ? model : `models/${model}`;
    const found = (json.models || []).some(m => m.name === wanted);
    if (!found) throw new Error(`Model "${model}" not available to this API key.`);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
