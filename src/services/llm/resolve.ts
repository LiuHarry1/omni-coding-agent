import type { LlmProfile, ProviderId, ThinkingConfig } from './types.js'

const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'openai-compatible']

export const DEFAULT_PROFILE: LlmProfile = {
  provider: 'openai-compatible',
  name: 'copilot-proxy',
  baseURL: 'http://localhost:4141/v1',
  apiKey: 'not-needed',
  model: 'gpt-5.4',
  thinking: { mode: 'off' },
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseThinking(raw: unknown): ThinkingConfig {
  if (raw === undefined || raw === null) return { mode: 'off' }
  if (!isRecord(raw)) return { mode: 'off' }

  const mode = raw.mode
  // User JSON often has `"thinking": {}` — treat absent mode like "off".
  if (mode === undefined || mode === null) return { mode: 'off' }
  switch (mode) {
    case 'off':
      return { mode: 'off' }
    case 'auto':
      return { mode: 'auto' }
    case 'low':
      return { mode: 'low' }
    case 'medium':
      return { mode: 'medium' }
    case 'high':
      return { mode: 'high' }
    case 'budget': {
      const tokens = typeof raw.tokens === 'number' ? raw.tokens : 0
      if (!(tokens > 0)) {
        throw new Error(
          `thinking.mode "budget" requires positive "tokens" (got ${raw.tokens})`,
        )
      }
      return { mode: 'budget', tokens }
    }
    default:
      throw new Error(`Unknown thinking.mode: ${String(mode)}`)
  }
}

/**
 * Strict normalization — no heuristics. Missing required fields throw.
 * Falls back to {@link DEFAULT_PROFILE} only when `raw` is empty/undefined.
 */
export function resolveProfile(raw: unknown): LlmProfile {
  if (raw === undefined || raw === null) return { ...DEFAULT_PROFILE }
  if (!isRecord(raw)) {
    throw new Error('LLM profile must be an object')
  }

  const merged = { ...DEFAULT_PROFILE, ...raw } as Record<string, unknown>

  const provider = merged.provider
  if (
    typeof provider !== 'string' ||
    !PROVIDERS.includes(provider as ProviderId)
  ) {
    throw new Error(
      `Invalid provider "${String(provider)}". Expected one of: ${PROVIDERS.join(', ')}`,
    )
  }

  const required = ['baseURL', 'apiKey', 'model'] as const
  for (const key of required) {
    if (typeof merged[key] !== 'string' || !merged[key]) {
      throw new Error(`LLM profile missing required field: ${key}`)
    }
  }

  return {
    provider: provider as ProviderId,
    name: typeof merged.name === 'string' ? merged.name : undefined,
    baseURL: merged.baseURL as string,
    apiKey: merged.apiKey as string,
    model: merged.model as string,
    thinking: parseThinking(merged.thinking),
    vision: typeof merged.vision === 'boolean' ? merged.vision : undefined,
    maxOutputTokens:
      typeof merged.maxOutputTokens === 'number' && merged.maxOutputTokens > 0
        ? merged.maxOutputTokens
        : undefined,
    contextWindow:
      typeof merged.contextWindow === 'number' && merged.contextWindow > 0
        ? merged.contextWindow
        : undefined,
  }
}

/** Round-trip a resolved profile back to a JSON-mergeable record. */
export function profileToRecord(p: LlmProfile): Record<string, unknown> {
  return {
    provider: p.provider,
    name: p.name,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    model: p.model,
    thinking: p.thinking,
    vision: p.vision,
    maxOutputTokens: p.maxOutputTokens,
    contextWindow: p.contextWindow,
  }
}
