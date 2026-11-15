import type { IProvider } from './types.js'
import {
  isModelTier,
  type ModelRegistry,
  type ModelTier,
} from './model-registry.js'

/**
 * Resolve provider + model id for a side-path fork (session-memory / auto-memory).
 *
 * - `cacheSafe: true` (default): reuse the main-loop provider/model so the
 *   fork can share prompt cache via CacheSafeParams.
 * - `cacheSafe: false`: use `modelTier` (default medium). Provider and model
 *   are always taken from the same tier — tiers may use different baseURLs.
 */
export function resolveSidePathModel(opts: {
  models: ModelRegistry
  /** When true/undefined, return main-loop provider + model. */
  cacheSafe?: boolean
  /** Tier for non-cacheSafe forks. Invalid values fall back to medium. */
  modelTier?: unknown
  mainProvider: IProvider
  mainModelId: string
  /** Fallback tier when cacheSafe is false and modelTier is omitted/invalid. */
  defaultTier?: ModelTier
}): { provider: IProvider; modelId: string; cacheSafe: boolean } {
  const cacheSafe = opts.cacheSafe !== false
  if (cacheSafe) {
    return {
      provider: opts.mainProvider,
      modelId: opts.mainModelId,
      cacheSafe: true,
    }
  }
  const tier = isModelTier(opts.modelTier)
    ? opts.modelTier
    : (opts.defaultTier ?? 'medium')
  return {
    provider: opts.models.provider(tier),
    modelId: opts.models.profile(tier).model,
    cacheSafe: false,
  }
}
