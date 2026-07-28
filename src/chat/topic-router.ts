/**
 * Cheap-model Topic classification for chat mode.
 *
 * Mirrors title-generator.ts's pattern: same cheap-model map, same
 * direct-fetch (no SDK), same resolveEngine credential resolution.
 *
 * Only actually calls a model when there are 2+ enabled Topics — 0 means
 * "no topic scoping" and 1 means "no real choice," both resolved without
 * a network round trip. Chat mode only supports claude/gpt4 orchestrator
 * nodes today (see chat-engine.ts), so this only needs those two engines.
 */
import { logger } from '../logger';
import type { AgentTopic } from '../types';
import type { ChatHistoryMessage } from './adapters/types';
import { resolveEngine, type EngineOverride } from './engine-resolver';

const CHEAP_MODEL: Record<'claude' | 'openai', string> = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
};

export interface ClassifyTopicParams {
  engineType: 'claude' | 'openai';
  topics: AgentTopic[];
  history: ChatHistoryMessage[];
  newUserMessage: string;
  /** Bias toward staying put — the Topic this session was on last turn. */
  previousTopicName?: string | null;
  engineOverride?: EngineOverride | null;
}

/**
 * Resolve the active Topic for this turn. Never throws — a classification
 * failure falls back to the first enabled Topic rather than breaking the
 * turn (same "never let an auxiliary call break the real reply" discipline
 * as title generation).
 */
export async function classifyTopic(params: ClassifyTopicParams): Promise<AgentTopic | null> {
  const enabled = params.topics.filter(t => t.isEnabled);
  if (enabled.length === 0) return null;
  if (enabled.length === 1) return enabled[0];

  try {
    const creds = resolveEngine(params.engineType, params.engineOverride);
    const model = CHEAP_MODEL[params.engineType];

    const recentUser = params.history.filter(m => m.role === 'user').slice(-2).map(m => m.content);
    const conversation = [...recentUser, params.newUserMessage].filter(Boolean).join('\n').slice(-1500);

    const options = enabled
      .map((t, i) => `${i + 1}. ${t.name} — ${t.routingDescription || '(no routing description)'}`)
      .join('\n');
    const bias = params.previousTopicName
      ? `\n\nThe conversation was previously on "${params.previousTopicName}" — stay on it unless the latest message clearly signals a different topic.`
      : '';
    const prompt =
      `Pick which ONE topic best matches the latest customer message below. Reply with ONLY the topic number, nothing else.\n\n` +
      `TOPICS:\n${options}${bias}\n\nLATEST MESSAGE:\n${conversation}`;

    const raw = params.engineType === 'claude'
      ? await classifyViaClaude(creds.apiKey, model, prompt, creds.endpoint)
      : await classifyViaOpenAi(creds.apiKey, model, prompt, creds.endpoint);

    const match = raw.match(/\d+/);
    const idx = match ? parseInt(match[0], 10) - 1 : -1;
    if (idx >= 0 && idx < enabled.length) return enabled[idx];

    logger.warn({ raw }, 'topic_classification_unparseable_falling_back');
    return enabled[0];
  } catch (err) {
    logger.warn({ err }, 'topic_classification_failed_falling_back');
    return enabled[0];
  }
}

async function classifyViaClaude(apiKey: string, model: string, prompt: string, endpoint: string | null): Promise<string> {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.anthropic.com') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude topic classify failed (${res.status})`);
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (json.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').trim();
}

async function classifyViaOpenAi(apiKey: string, model: string, prompt: string, endpoint: string | null): Promise<string> {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.openai.com') + '/v1/responses';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      max_output_tokens: 10,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI topic classify failed (${res.status})`);
  const json = (await res.json()) as { output_text?: string };
  return json.output_text || '';
}
