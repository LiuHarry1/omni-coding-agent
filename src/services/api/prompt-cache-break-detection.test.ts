import { afterEach, describe, expect, it } from 'vitest'
import { jsonSchema } from 'ai'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  resetPromptCacheBreakDetection,
  type PromptStateSnapshot,
} from './prompt-cache-break-detection.js'

const readTool = {
  description: 'Read a file',
  inputSchema: jsonSchema({ type: 'object', properties: {} }),
}
const m1 = { role: 'user', content: 'hi' }
const m2 = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
const m3 = { role: 'user', content: 'next' }

function snapshot(over: Partial<PromptStateSnapshot> = {}) {
  return {
    key: 's1:main',
    system: 'You are helpful.',
    tools: { Read: readTool },
    model: 'claude-sonnet-4-5',
    messages: [m1],
    ...over,
  }
}

/** Records a request and answers it with the given cache reads. */
function request(over: Partial<PromptStateSnapshot>, cacheRead: number) {
  recordPromptState(snapshot(over))
  return checkResponseForCacheBreak('s1:main', cacheRead, 0, 1_000)
}

describe('prompt cache break detection', () => {
  afterEach(() => resetPromptCacheBreakDetection())

  it('names the system prompt change behind a drop', () => {
    expect(request({}, 10_000)).toBeNull()
    const result = request(
      { system: 'You are helpful. Today is Monday.', messages: [m1, m2, m3] },
      0,
    )
    expect(result?.reason).toBe('system prompt changed (+17 chars)')
    expect(result?.previousCacheReadTokens).toBe(10_000)
  })

  it('names added, removed and changed tools and a model switch', () => {
    request({}, 10_000)
    const result = request(
      {
        model: 'claude-opus-4-1',
        tools: {
          Read: { ...readTool, description: 'Read any file' },
          Grep: readTool,
        },
        messages: [m1, m2],
      },
      100,
    )
    expect(result?.reason).toBe(
      'model changed (claude-sonnet-4-5 → claude-opus-4-1), ' +
        'tools changed (+Grep), tool schemas changed (Read)',
    )
  })

  it('ignores small drops and drops after the history was rewritten', () => {
    request({}, 10_000)
    expect(request({ messages: [m1, m2] }, 9_000)).toBeNull()
    // Compaction replaced the earlier messages.
    expect(request({ messages: [m3] }, 0)).toBeNull()
  })

  it('blames the server when nothing changed', () => {
    request({}, 10_000)
    expect(request({ messages: [m1, m2] }, 0)?.reason).toBe(
      'likely server-side (prompt unchanged, <5min gap)',
    )
  })

  it('suspects TTL expiry after a long gap', () => {
    recordPromptState(snapshot())
    checkResponseForCacheBreak('s1:main', 10_000, 0, 0)
    recordPromptState(snapshot({ messages: [m1, m2] }))
    expect(
      checkResponseForCacheBreak('s1:main', 0, 0, 10 * 60 * 1000)?.reason,
    ).toBe('possible 5min TTL expiry (prompt unchanged)')
  })

  it('keeps a change seen by a failed attempt for the retry', () => {
    request({}, 10_000)
    recordPromptState(snapshot({ system: 'changed' }))
    // The retry sends the same prompt again before any response.
    recordPromptState(snapshot({ system: 'changed' }))
    expect(checkResponseForCacheBreak('s1:main', 0, 0, 1_000)?.reason).toMatch(
      /^system prompt changed/,
    )
  })
})
