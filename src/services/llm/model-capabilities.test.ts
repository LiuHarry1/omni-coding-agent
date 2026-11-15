import { describe, expect, it } from 'vitest'
import { knownContextWindow } from './model-capabilities.js'

describe('knownContextWindow', () => {
  it.each([
    ['claude-sonnet-4-5', 200_000],
    ['claude-sonnet-4-5[1m]', 1_000_000],
    ['gpt-4.1-mini', 1_047_576],
    ['gpt-4o', 128_000],
    ['GPT-5.4', 400_000],
    ['o3', 200_000],
    ['o4-mini', 200_000],
  ])('%s has %i tokens', (model, window) => {
    expect(knownContextWindow(model)).toBe(window)
  })

  it('does not guess for models it does not know', () => {
    expect(knownContextWindow('qwen3-coder')).toBeUndefined()
    expect(knownContextWindow('omni-1')).toBeUndefined()
  })
})
