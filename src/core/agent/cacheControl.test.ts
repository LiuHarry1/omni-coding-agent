import { describe, expect, it } from 'vitest'
import type { IProvider } from '../../services/llm/types.js'
import { systemWithCacheBreakpoint } from './cacheControl.js'

const anthropicOpts = { anthropic: { cacheControl: { type: 'ephemeral' } } }

describe('systemWithCacheBreakpoint', () => {
  it('ends the system prompt with a cache breakpoint when supported', () => {
    const provider = {
      cacheControlOptions: () => anthropicOpts,
    } as unknown as IProvider
    expect(systemWithCacheBreakpoint('You are helpful.', provider)).toEqual([
      {
        role: 'system',
        content: 'You are helpful.',
        providerOptions: anthropicOpts,
      },
    ])
  })

  it('passes the plain string through otherwise', () => {
    const provider = {} as IProvider
    expect(systemWithCacheBreakpoint('You are helpful.', provider)).toBe(
      'You are helpful.',
    )
    const withOpts = {
      cacheControlOptions: () => anthropicOpts,
    } as unknown as IProvider
    expect(systemWithCacheBreakpoint('', withOpts)).toBe('')
  })
})
