import { afterEach, describe, expect, it } from 'vitest'
import { cachedPromptSection, clearPromptSections } from './section-cache.js'

describe('cachedPromptSection', () => {
  afterEach(() => {
    clearPromptSections('s1')
    clearPromptSections('s2')
  })

  it('computes a section once per session until cleared', () => {
    let source = 'v1'
    const read = (id: string) => cachedPromptSection(id, 'memory', () => source)

    expect(read('s1')).toBe('v1')
    source = 'v2'
    expect(read('s1')).toBe('v1')
    expect(read('s2')).toBe('v2')

    clearPromptSections('s1')
    expect(read('s1')).toBe('v2')
  })

  it('keeps sections with different names apart', () => {
    expect(cachedPromptSection('s1', 'a', () => 'A')).toBe('A')
    expect(cachedPromptSection('s1', 'b', () => 'B')).toBe('B')
  })
})
