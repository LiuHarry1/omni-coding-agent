import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sessions = new Map<
  string,
  { id: string; ownerEmail?: string; permissionMode: { mode: string } }
>()
const rewind = vi.hoisted(() => ({
  previewRewind: vi.fn(() => ({
    canRestoreFiles: false,
    changedFiles: [],
    createdFiles: [],
  })),
  rewindSession: vi.fn(() => ({ prompt: 'again', files: null })),
  forkSession: vi.fn(() => ({ session: { id: 'fork-1' }, prompt: 'again' })),
}))

vi.mock('../session.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../session.js')>()),
  getSession: (id: string) => sessions.get(id) ?? null,
}))
vi.mock('../../session/rewind.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../session/rewind.js')>()),
  ...rewind,
}))
vi.mock('../session-ui.js', () => ({ sessionJsonlToUIMessages: () => [] }))

const { handleSessionRewind } = await import('./session-rewind.js')

const S = 'rewind-route-session'
const alice = { email: 'alice@example.com', role: 'user' }
const bob = { email: 'bob@example.com', role: 'user' }
const admin = { email: 'admin@example.com', role: 'super' }

async function call(
  method: string,
  url: string,
  user: { email: string; role: string },
  body?: unknown,
): Promise<{ status?: number; json?: Record<string, unknown> }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage
  req.method = method
  req.url = url
  ;(req as unknown as { user: typeof user }).user = user
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
  await handleSessionRewind(req, res)
  return {
    status: out.status,
    json: out.text ? JSON.parse(out.text) : undefined,
  }
}

const previousAuth = process.env.AUTH_ENABLED

beforeEach(() => {
  process.env.AUTH_ENABLED = 'true'
  sessions.set(S, {
    id: S,
    ownerEmail: alice.email,
    permissionMode: { mode: 'plan' },
  })
})

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  sessions.clear()
  vi.clearAllMocks()
})

describe('rewind and fork routes', () => {
  it('lets the owner rewind and fork', async () => {
    const rewound = await call('POST', `/sessions/${S}/rewind`, alice, {
      message_id: 'u2',
    })
    // With the mode the session is in afterwards, for the client to show.
    expect(rewound).toMatchObject({
      status: 200,
      json: { prompt: 'again', mode: 'plan', agent_type: null },
    })
    expect(rewind.rewindSession).toHaveBeenCalledOnce()

    const forked = await call('POST', `/sessions/${S}/fork`, alice, {
      message_id: 'u2',
    })
    expect(forked).toMatchObject({
      status: 200,
      json: { session_id: 'fork-1' },
    })
  })

  it("lets a super user look at another user's session but not change it", async () => {
    const preview = await call('GET', `/sessions/${S}/rewind/u2`, admin)
    expect(preview.status).toBe(200)

    for (const action of ['rewind', 'fork']) {
      const response = await call('POST', `/sessions/${S}/${action}`, admin, {
        message_id: 'u2',
      })
      expect(response.status).toBe(403)
    }
    expect(rewind.rewindSession).not.toHaveBeenCalled()
    expect(rewind.forkSession).not.toHaveBeenCalled()
  })

  it('hides the session from other users', async () => {
    const response = await call('POST', `/sessions/${S}/rewind`, bob, {
      message_id: 'u2',
    })
    expect(response.status).toBe(404)
    expect(rewind.rewindSession).not.toHaveBeenCalled()
  })
})
