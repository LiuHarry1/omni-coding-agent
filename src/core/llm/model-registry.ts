import type { IProvider, LlmProfile, ProviderId } from './types.js'
import { anthropicStrategy } from './strategies/anthropic.js'
import { openaiStrategy } from './strategies/openai.js'
import { openaiCompatibleStrategy } from './strategies/openai-compatible.js'
import { DEFAULT_PROFILE, profileToRecord, resolveProfile } from './resolve.js'

const STRATEGIES = {
  openai: openaiStrategy,
  anthropic: anthropicStrategy,
  'openai-compatible': openaiCompatibleStrategy,
} as const

function buildTierProvider(profile: LlmProfile): IProvider {
  const strat = STRATEGIES[profile.provider as ProviderId]
  if (!strat) {
    throw new Error(`No strategy registered for provider "${profile.provider}"`)
  }
  return strat.build(profile)
}

/**
 * Three-tier model ladder:
 * - large  ≈ Opus / mainLoopModel
 * - medium ≈ Sonnet
 * - small  ≈ Haiku / SMALL_FAST
 */
export type ModelTier = 'large' | 'medium' | 'small'

export const MODEL_TIERS: readonly ModelTier[] = [
  'large',
  'medium',
  'small',
] as const

export function isModelTier(value: unknown): value is ModelTier {
  return value === 'large' || value === 'medium' || value === 'small'
}

export interface ModelProfiles {
  large: LlmProfile
  medium: LlmProfile
  small: LlmProfile
}

export interface ModelRegistry {
  /** Resolved profiles after fallback (small→medium→large, medium→large). */
  profiles: ModelProfiles
  profile(tier: ModelTier): LlmProfile
  provider(tier: ModelTier): IProvider
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Resolve three tiers from settings.
 *
 * - Missing `models.large` → DEFAULT_PROFILE.
 * - Missing medium → clone large; missing small → clone medium (then large).
 */
export function resolveModelProfiles(input: {
  models?: unknown
}): ModelProfiles {
  const modelsRaw = isRecord(input.models) ? input.models : {}

  const large = isRecord(modelsRaw.large)
    ? resolveProfile({
        ...profileToRecord(DEFAULT_PROFILE),
        ...modelsRaw.large,
      })
    : { ...DEFAULT_PROFILE }

  const medium = isRecord(modelsRaw.medium)
    ? resolveTierProfile(large, modelsRaw.medium)
    : { ...large }

  const small = isRecord(modelsRaw.small)
    ? resolveTierProfile(medium, modelsRaw.small)
    : { ...medium }

  return { large, medium, small }
}

function resolveTierProfile(
  parent: LlmProfile,
  raw: Record<string, unknown>,
): LlmProfile {
  const profile = resolveProfile({ ...profileToRecord(parent), ...raw })
  // An output ceiling describes one model; a tier that swaps the model
  // must not inherit it (e.g. small: gpt-4o-mini under a 64k large).
  if (raw.maxOutputTokens === undefined && profile.model !== parent.model) {
    profile.maxOutputTokens = undefined
  }
  return profile
}

export function createModelRegistry(profiles: ModelProfiles): ModelRegistry {
  const cache = new Map<ModelTier, IProvider>()

  const provider = (tier: ModelTier): IProvider => {
    let p = cache.get(tier)
    if (!p) {
      p = buildTierProvider(profiles[tier])
      cache.set(tier, p)
    }
    return p
  }

  return {
    profiles,
    profile: tier => profiles[tier],
    provider,
  }
}

/** Serialize profiles for settings merge / disk (api keys intact). */
export function modelProfilesToRecord(
  profiles: ModelProfiles,
): Record<string, unknown> {
  return {
    large: profileToRecord(profiles.large),
    medium: profileToRecord(profiles.medium),
    small: profileToRecord(profiles.small),
  }
}
