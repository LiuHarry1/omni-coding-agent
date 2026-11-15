import type {
  IProvider,
  LlmProfile,
  ProviderId,
  ProviderStrategy,
} from './types.js'
import { openaiStrategy } from './strategies/openai.js'
import { anthropicStrategy } from './strategies/anthropic.js'
import { openaiCompatibleStrategy } from './strategies/openai-compatible.js'

const STRATEGIES: Record<ProviderId, ProviderStrategy> = {
  openai: openaiStrategy,
  anthropic: anthropicStrategy,
  'openai-compatible': openaiCompatibleStrategy,
}

export function buildProvider(profile: LlmProfile): IProvider {
  const strat = STRATEGIES[profile.provider]
  if (!strat)
    throw new Error(`No strategy registered for provider "${profile.provider}"`)
  return strat.build(profile)
}

export * from './types.js'
export { resolveProfile, profileToRecord, DEFAULT_PROFILE } from './resolve.js'
export {
  createModelRegistry,
  isModelTier,
  modelProfilesToRecord,
  resolveModelProfiles,
  MODEL_TIERS,
  type ModelProfiles,
  type ModelRegistry,
  type ModelTier,
} from './model-registry.js'
export { resolveSidePathModel } from './resolve-side-path-model.js'
