import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../core/types.js'
import { registerSessionLocation } from '../../session/paths.js'
import {
  appendSidechainMessage,
  appendSidechainTurnTiming,
  readSidechain,
  writeSidechainMeta,
} from '../../session/sidechain.js'

const sessions = new Map<string, { id: string; ownerEmail?: string }>()

vi.mock('../session.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../session.js')>()),
  getSession: (id: string) => sessions.get(id) ?? null,
}))

const { handleSessionSubagents } = await import('./session-subagents.js')

const AGENT = 'a1b2c3d4e'
const alice = { email: 'alice@example.com', role: 'user' }
const bob = { email: 'bob@example.com', role: 'user' }
const admin = { email: 'admin@example.com', role: 'super' }

type UIMessage = {
  type: string
  content?: string
  parts?: Array<Record<string, unknown>>
}

function call(
  method: string,
  url: string,
  user: { email: string; role: string },
): {
  handled: boolean
  status?: number
  json?: { agent?: unknown; messages?: UIMessage[]; error?: string }
} {
  const req = Readable.from([]) as unknown as IncomingMessage
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
  const handled = handleSessionSubagents(req, res)
  return {
    handled,
    status: out.status,
    json: out.text ? JSON.parse(out.text) : undefined,
  }
}

const transcript: Message[] = [
  { role: 'user', content: 'List every HTTP route.', uuid: 'u-1' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Looking at the router first.' },
      {
        type: 'tool-call',
        toolCallId: 'read-1',
        toolName: 'Read',
        input: { file_path: 'src/server/router.ts' },
      },
    ],
    uuid: 'a-1',
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'read-1',
        toolName: 'Read',
        output: { type: 'text', value: 'router source' },
      },
    ],
    uuid: 't-1',
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Found 12 routes.' }],
    uuid: 'a-2',
  },
] as Message[]

let agentHome: string
let sessionId: string
const previousAuth = process.env.AUTH_ENABLED

beforeEach(() => {
  process.env.AUTH_ENABLED = 'true'
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-route-home-'))
  sessionId = `subagent-route-${Date.now()}-${Math.random().toString(36).slice(2)}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
  sessions.set(sessionId, { id: sessionId, ownerEmail: alice.email })
  writeSidechainMeta(sessionId, {
    agentId: AGENT,
    agentType: 'Explore',
    description: 'Audit the routes',
    createdAt: 1700000000000,
  })
  for (const message of transcript) {
    appendSidechainMessage(sessionId, AGENT, message)
  }
})

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  sessions.clear()
  fs.rmSync(agentHome, { recursive: true, force: true })
})

describe('GET /sessions/:id/subagents/:agentId', () => {
  it("serves the subagent's conversation the way a session's is served", () => {
    const response = call(
      'GET',
      `/sessions/${sessionId}/subagents/${AGENT}`,
      alice,
    )

    expect(response.status).toBe(200)
    expect(response.json!.agent).toEqual({
      agent_id: AGENT,
      agent_type: 'Explore',
      description: 'Audit the routes',
      created_at: 1700000000000,
    })
    const messages = response.json!.messages!
    expect(messages.map(m => m.type)).toEqual(['user', 'assistant'])
    expect(messages[0]!.content).toBe('List every HTTP route.')
    // What it said between its tool calls is there, not only the report.
    expect(messages[1]!.parts).toMatchObject([
      { type: 'text', content: 'Looking at the router first.' },
      {
        type: 'tool_call',
        toolCallId: 'read-1',
        name: 'Read',
        status: 'done',
        result: 'router source',
      },
      { type: 'text', content: 'Found 12 routes.' },
    ])
  })

  it('says which model the agent ran on and how long each run took', () => {
    writeSidechainMeta(sessionId, {
      agentId: AGENT,
      agentType: 'Explore',
      description: 'Audit the routes',
      createdAt: 1700000000000,
      model: 'small-model',
    })
    appendSidechainTurnTiming(
      sessionId,
      AGENT,
      'u-1',
      1700000000000,
      1700000011000,
    )

    const response = call(
      'GET',
      `/sessions/${sessionId}/subagents/${AGENT}`,
      alice,
    )

    expect(response.json!.agent).toMatchObject({ model: 'small-model' })
    expect(response.json!.messages![0]).toMatchObject({
      type: 'user',
      turnStartTime: 1700000000000,
      turnEndTime: 1700000011000,
    })
  })

  it('leaves a running agent able to go on writing where it was', () => {
    call('GET', `/sessions/${sessionId}/subagents/${AGENT}`, alice)
    appendSidechainMessage(sessionId, AGENT, {
      role: 'assistant',
      content: [{ type: 'text', text: 'One more thing.' }],
      uuid: 'a-3',
    } as Message)

    expect(readSidechain(sessionId, AGENT)!.messages.map(m => m.uuid)).toEqual([
      'u-1',
      'a-1',
      't-1',
      'a-2',
      'a-3',
    ])
  })

  it('shows it to whoever may read the session, and to nobody else', () => {
    const url = `/sessions/${sessionId}/subagents/${AGENT}`
    expect(call('GET', url, admin).status).toBe(200)
    expect(call('GET', url, bob)).toMatchObject({
      status: 404,
      json: { error: 'Session not found' },
    })
    expect(call('GET', `/sessions/nope/subagents/${AGENT}`, alice).status).toBe(
      404,
    )
  })

  it('answers 404 for an agent that left no transcript or an id that is not one', () => {
    for (const id of ['a00000000', '..%2F..%2Fsecrets', '%E0%A4%A']) {
      expect(
        call('GET', `/sessions/${sessionId}/subagents/${id}`, alice),
      ).toMatchObject({ status: 404, json: { error: 'Subagent not found' } })
    }
  })

  it('leaves other methods and paths to the other routes', () => {
    const url = `/sessions/${sessionId}/subagents/${AGENT}`
    expect(call('POST', url, alice).handled).toBe(false)
    expect(call('GET', `/sessions/${sessionId}/subagents`, alice).handled).toBe(
      false,
    )
    expect(call('GET', `${url}/messages`, alice).handled).toBe(false)
  })
})
