import { describe, expect, it } from 'vitest'
import { queryEvents } from './query.js'
import type { QueryEvent } from './query/events.js'
import type { QueryResult } from './query/types.js'
import { createQueryHarness } from './query-test-harness.js'
import type { Message } from './types.js'

async function drain(
  gen: AsyncGenerator<QueryEvent, QueryResult>,
): Promise<{ events: QueryEvent[]; result: QueryResult }> {
  const events: QueryEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

const messageEvents = (events: QueryEvent[]) =>
  events.flatMap(e => (e.type === 'message' ? [e.message] : []))

describe('queryEvents', () => {
  it('yields every appended message once, in order', async () => {
    const h = createQueryHarness()
    h.scriptSteps(
      [
        { toolCalls: [{ toolCallId: 'c1', toolName: 'Read', input: {} }] },
        { text: 'done' },
      ],
      (index, args) => {
        if (index === 0) {
          args.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'reading' }],
          } as Message)
        }
      },
    )
    const { events, result } = await drain(
      queryEvents({ ...h.options, newMessagesFrom: 0 }),
    )
    expect(messageEvents(events)).toEqual(result.messages)
    expect(result.reason).toBe('completed')
  })

  it('reports retries, fallbacks and usage from the loop phases', async () => {
    const h = createQueryHarness()
    h.scriptSteps([{ text: 'ok' }], (_index, args) => {
      args.eventBus.emit('transient_retry', {
        attempt: 1,
        max: 10,
        backoffMs: 500,
        error: 'overloaded',
      })
      args.eventBus.emit('model_fallback', {
        originalModel: 'big',
        fallbackModel: 'small',
      })
      args.eventBus.emit('usage', {
        step: 0,
        model: 'big',
        inputTokens: 10,
        outputTokens: 2,
        cacheWriteTokens: 5,
        totalTokens: 12,
      })
    })
    const { events } = await drain(queryEvents(h.options))
    expect(events.filter(e => e.type !== 'message')).toEqual([
      {
        type: 'notice',
        notice: {
          kind: 'retry',
          attempt: 1,
          max_attempts: 10,
          delay_ms: 500,
          error: 'overloaded',
        },
      },
      {
        type: 'notice',
        notice: { kind: 'model_fallback', from: 'big', to: 'small' },
      },
      {
        type: 'usage',
        usage: {
          step: 0,
          model: 'big',
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 0,
          cacheWriteTokens: 5,
          reasoningTokens: 0,
          totalTokens: 12,
        },
      },
    ])
  })

  it('announces compaction rows before they arrive as messages', async () => {
    const h = createQueryHarness()
    const summary = {
      role: 'user',
      uuid: 'summary',
      content: 'summary',
      isCompactSummary: true,
    } as Message
    h.deps.preTurn.mockImplementation(
      async ({ messages, onFullCompaction }) => {
        messages.push(summary)
        onFullCompaction?.([summary])
        return messages
      },
    )
    h.scriptSteps([{ text: 'ok' }])
    const { events } = await drain(queryEvents(h.options))
    const compactionAt = events.findIndex(e => e.type === 'compaction')
    const summaryAt = events.findIndex(
      e => e.type === 'message' && e.message === summary,
    )
    expect(compactionAt).toBeGreaterThanOrEqual(0)
    expect(summaryAt).toBeGreaterThan(compactionAt)
  })

  it('stops at the blocking limit when auto-compaction is off', async () => {
    const h = createQueryHarness({
      compaction: { enabled: false, contextWindow: 30_000 },
      messages: [{ role: 'user', uuid: 'u1', content: 'x'.repeat(200_000) }],
    } as never)
    const { events, result } = await drain(queryEvents(h.options))
    expect(h.deps.runStep).not.toHaveBeenCalled()
    expect(result.terminal.reason).toBe('blocking_limit')
    expect(result.reason).toBe('error')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        notice: expect.objectContaining({ kind: 'context_blocked' }),
      }),
    )
    expect(h.events.at(-1)).toMatchObject({ type: 'result', subtype: 'error' })
  })
})
