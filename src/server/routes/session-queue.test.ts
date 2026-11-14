import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endTurn, tryBeginTurn } from '../../session/store.js'
import {
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'

const sessions = new Map<string, { id: string; ownerEmail?: string }>()

vi.mock('../session.js', () => ({
  getSession: (id: string) => sessions.get(id) ?? null,
  canAccessSession: (session: { ownerEmail?: string }, email?: string) =>
    !session.ownerEmail || session.ownerEmail === email,
}))

const { handleSessionQueue, MAX_QUEUED_PROMPTS } =
  await import('./session-queue.js')

const S = 'queue-route-session'

async function call(
  method: string,
  url: string,
  body?: unknown,
  email?: string,
): Promise<{
  handled: boolean
  status?: number
  json?: Record<string, unknown>
}> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage
  req.method = method
  req.url = url
  ;(req as unknown as { user?: { email: string } }).user = email
    ? { email }
    : undefined
  const out: { status?: number; text: string } = { text: '' }
  const res = {
    setHeader() {},
    writeHead(status: number) {
      out.status = status
    },
    end(chunk?: string) {
      out.text += chunk ?? ''
    },
  } as unknown as ServerResponse
  const handled = await handleSessionQueue(req, res)
  return {
    handled,
    status: out.status,
    json: out.text ? JSON.parse(out.text) : undefined,
  }
}

beforeEach(() => {
  sessions.set(S, { id: S })
})

afterEach(() => {
  endTurn(S)
  resetCommandQueue()
  sessions.clear()
})

describe('session queue routes', () => {
  it('queues a message for the running turn', async () => {
    tryBeginTurn(S, '/tmp/agent-home')

    const response = await call('POST', `/sessions/${S}/queue`, {
      message: 'also fix b.ts',
      id: 'm1',
    })

    expect(response).toMatchObject({
      status: 202,
      json: { queued: true, id: 'm1' },
    })
    expect(getCommandQueue(S)).toEqual([
      { value: 'also fix b.ts', mode: 'prompt', uuid: 'm1', priority: 'next' },
    ])
  })

  it('gives a message without an id one of its own', async () => {
    tryBeginTurn(S, '/tmp/agent-home')

    const response = await call('POST', `/sessions/${S}/queue`, {
      message: 'hello',
    })

    expect(response.status).toBe(202)
    expect(getCommandQueue(S)[0]!.uuid).toBe(response.json!.id)
    expect(String(response.json!.id)).not.toBe('')
  })

  it('refuses when no turn is running', async () => {
    const response = await call('POST', `/sessions/${S}/queue`, {
      message: 'hello',
    })

    expect(response).toMatchObject({ status: 409, json: { queued: false } })
    expect(getCommandQueue(S)).toEqual([])
  })

  it('does not queue the same message twice', async () => {
    tryBeginTurn(S, '/tmp/agent-home')

    await call('POST', `/sessions/${S}/queue`, { message: 'hello', id: 'm1' })
    const again = await call('POST', `/sessions/${S}/queue`, {
      message: 'hello',
      id: 'm1',
    })

    expect(again.status).toBe(202)
    expect(getCommandQueue(S)).toHaveLength(1)
  })

  it('rejects an empty message and a full queue', async () => {
    tryBeginTurn(S, '/tmp/agent-home')

    expect(
      (await call('POST', `/sessions/${S}/queue`, { message: '  ' })).status,
    ).toBe(400)

    for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) {
      enqueue(S, { value: `m${i}`, mode: 'prompt', uuid: `m${i}` })
    }
    expect(
      (await call('POST', `/sessions/${S}/queue`, { message: 'one too many' }))
        .status,
    ).toBe(429)
  })

  it('lists and removes only the user’s own messages', async () => {
    tryBeginTurn(S, '/tmp/agent-home')
    enqueue(S, { value: 'typed', mode: 'prompt', uuid: 'm1' })
    enqueue(S, { value: 'to agent', mode: 'prompt', uuid: 'm2', agentId: 'a1' })
    enqueuePendingNotification(S, {
      value: '<task-notification>x</task-notification>',
      mode: 'task-notification',
      uuid: 'm3',
    })

    expect((await call('GET', `/sessions/${S}/queue`)).json).toEqual({
      turn_active: true,
      queued: [{ id: 'm1', message: 'typed' }],
    })

    expect((await call('DELETE', `/sessions/${S}/queue/m3`)).json).toEqual({
      removed: false,
    })
    expect((await call('DELETE', `/sessions/${S}/queue/m1`)).json).toEqual({
      removed: true,
    })
    expect(getCommandQueue(S).map(c => c.uuid)).toEqual(['m2', 'm3'])
  })

  it('answers 404 for a session the caller cannot use', async () => {
    sessions.set(S, { id: S, ownerEmail: 'alice@example.com' })
    tryBeginTurn(S, '/tmp/agent-home')

    expect(
      (
        await call(
          'POST',
          `/sessions/${S}/queue`,
          { message: 'hello' },
          'bob@example.com',
        )
      ).status,
    ).toBe(404)
    expect((await call('GET', '/sessions/unknown/queue')).status).toBe(404)
    expect(getCommandQueue(S)).toEqual([])
  })

  it('leaves other paths and methods to the rest of the router', async () => {
    expect((await call('GET', `/sessions/${S}/messages`)).handled).toBe(false)
    expect((await call('PUT', `/sessions/${S}/queue`)).handled).toBe(false)
    expect((await call('GET', `/sessions/${S}/queue/m1`)).handled).toBe(false)
  })
})
