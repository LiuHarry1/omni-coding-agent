import { describe, expect, it } from 'vitest'
import { createModelRegistry, resolveModelProfiles } from './model-registry.js'

const base = {
  provider: 'anthropic',
  baseURL: 'https://api.example.com',
  apiKey: 'k',
}

describe('resolveModelProfiles maxOutputTokens', () => {
  it('keeps the cap on tiers that reuse the same model', () => {
    const profiles = resolveModelProfiles({
      models: {
        large: { ...base, model: 'big', maxOutputTokens: 64_000 },
        medium: { thinking: { mode: 'low' } },
      },
    })
    expect(profiles.medium.maxOutputTokens).toBe(64_000)
    expect(profiles.small.maxOutputTokens).toBe(64_000)
  })

  it('drops the inherited cap when a tier swaps the model', () => {
    const profiles = resolveModelProfiles({
      models: {
        large: { ...base, model: 'big', maxOutputTokens: 64_000 },
        small: { model: 'tiny' },
      },
    })
    expect(profiles.small.maxOutputTokens).toBeUndefined()
  })

  it('uses a tier’s own cap and exposes it on the provider', () => {
    const profiles = resolveModelProfiles({
      models: {
        large: { ...base, model: 'big' },
        small: { model: 'tiny', maxOutputTokens: 8_192 },
      },
    })
    const registry = createModelRegistry(profiles)
    expect(registry.provider('large').maxOutputTokenCap?.()).toBeUndefined()
    expect(registry.provider('small').maxOutputTokenCap?.()).toBe(8_192)
  })
})

describe('fallbackProvider', () => {
  const profiles = resolveModelProfiles({
    models: {
      large: { ...base, model: 'big' },
      medium: { model: 'mid' },
      small: { model: 'tiny' },
    },
  })

  it('is the configured smaller tier', () => {
    const registry = createModelRegistry(profiles, { fallbackTier: 'medium' })

    expect(registry.fallbackProvider('large')).toBe(registry.provider('medium'))
  })

  it('is absent when no fallback tier is configured', () => {
    expect(
      createModelRegistry(profiles).fallbackProvider('large'),
    ).toBeUndefined()
  })

  it('never points at the same or a larger tier', () => {
    const registry = createModelRegistry(profiles, { fallbackTier: 'medium' })

    expect(registry.fallbackProvider('medium')).toBeUndefined()
    expect(registry.fallbackProvider('small')).toBeUndefined()
  })

  it('is absent when the fallback tier is the same model', () => {
    const sameModel = resolveModelProfiles({
      models: { large: { ...base, model: 'big' } },
    })
    const registry = createModelRegistry(sameModel, { fallbackTier: 'small' })

    expect(registry.fallbackProvider('large')).toBeUndefined()
  })
})
