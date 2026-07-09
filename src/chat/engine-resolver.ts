/**
 * Engine credential resolver.
 *
 * The runtime chat turn payload from Apex includes an optional
 * `engineOverride: { engineType, apiKey, endpoint, defaultModel, connectionId }`
 * that was resolved from the running user's AiEngineConnection__c records.
 *
 * If present → use it. Otherwise → fall back to the server's .env keys.
 *
 * We NEVER persist the key in Node — it's used per-request and dropped.
 * Apex is the source of truth; Node is stateless for credentials.
 */
import { config } from '../config';

export interface EngineOverride {
  engineType?:   string;
  apiKey?:       string;
  endpoint?:     string;
  defaultModel?: string;
  connectionId?: string;
}

export interface ResolvedEngineCredentials {
  apiKey:       string;
  endpoint:     string | null;
  defaultModel: string | null;
  source:       'user' | 'env';
  connectionId: string | null;
}

/**
 * Resolve credentials for a specific engine, given the (optional) override
 * from Apex and the default fallbacks from .env.
 *
 * Throws if the resolved key would be empty (dev didn't set .env and the user
 * hasn't configured a connection).
 */
export function resolveEngine(
  engineType: 'claude' | 'openai' | 'gemini',
  override?:  EngineOverride | null,
): ResolvedEngineCredentials {
  if (override && override.engineType === engineType && override.apiKey) {
    return {
      apiKey:       override.apiKey,
      endpoint:     override.endpoint ?? null,
      defaultModel: override.defaultModel ?? null,
      source:       'user',
      connectionId: override.connectionId ?? null,
    };
  }

  // Fall back to server-side .env
  const envKey = engineType === 'claude' ? config.anthropic.apiKey
              : engineType === 'openai' ? config.openai.apiKey
              : engineType === 'gemini' ? config.gemini.apiKey
              : '';

  if (!envKey) {
    throw new Error(
      `No API key configured for ${engineType}. ` +
      `Add one under AI Engine Setup, or set the server-side .env fallback.`,
    );
  }

  return {
    apiKey:       envKey,
    endpoint:     null,
    defaultModel: null,
    source:       'env',
    connectionId: null,
  };
}
