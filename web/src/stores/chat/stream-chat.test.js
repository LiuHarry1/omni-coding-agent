import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  streamRun: vi.fn(),
  getRun: vi.fn(),
}))

vi.mock('../../lib/api/agent.js', () => ({
  agentApi: api,
}))

import { streamDurableRun } from './stream-chat.js'

function sseResponse(frames) {
  const body = frames
    .map(
      ({ id, event }) =>
        `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('durable run reconnect', () => {
  it('deduplicates by event id and resumes from the last observed seq', async () => {
    api.streamRun.mockReset()
    api.getRun.mockReset()
    api.streamRun
      .mockResolvedValueOnce(
        sseResponse([
          {
            id: 1,
            event: {
              type: 'stream_event',
              delta: { kind: 'text', text: 'duplicate' },
            },
          },
          {
            id: 2,
            event: {
              type: 'stream_event',
              delta: { kind: 'text', text: 'new' },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          {
            id: 3,
            event: { type: 'result', subtype: 'success', reason: 'done' },
          },
        ]),
      )
    api.getRun.mockResolvedValueOnce({ status: 'running' })

    const events = []
    const meta = await streamDurableRun({
      runId: 'run-1',
      afterSeq: 1,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    })

    expect(events.map(event => event.__eventId)).toEqual(['2', '3'])
    expect(meta.lastSeq).toBe(3)
    expect(api.streamRun.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['run-1', 1],
      ['run-1', 2],
    ])
  })

  it('synthesizes a terminal event when status became final off-stream', async () => {
    api.streamRun.mockReset()
    api.getRun.mockReset()
    api.streamRun.mockResolvedValueOnce(sseResponse([]))
    api.getRun.mockResolvedValueOnce({
      status: 'error',
      sessionId: 'session-1',
      error: 'recovery failed',
    })

    const events = []
    await streamDurableRun({
      runId: 'run-error',
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
    })

    expect(events).toEqual([
      {
        type: 'result',
        subtype: 'error',
        error: 'recovery failed',
        session_id: 'session-1',
      },
    ])
  })
})
