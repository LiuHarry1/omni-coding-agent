import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { createDefaultPermissionMode } from '../../utils/permissions/permission-mode.js'
import { registerSessionLocation } from '../../session/paths.js'
import { ToolRegistry } from '../../core/tool-registry.js'
import type {
  AgentDefinition,
  AgentOptions,
  AnyTool,
  Message,
  ToolContext,
} from '../../core/types.js'
import { WireEmitter } from '../../core/wire-emitter.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import { readSidechain } from '../../session/sidechain.js'
import { createTaskTool } from './AgentTool.js'
import { createSendMessageTool } from './SendMessageTool.js'

type ExecutableTool = AnyTool & {
  execute: (input: unknown, options?: unknown) => Promise<unknown>
}
type ToolResult = { data: { text: string } }

const fixtureAgent: AgentDefinition = {
  agentType: 'fixture-agent',
  whenToUse: 'Tests',
  description: 'Deterministic fixture agent',
  systemPrompt: 'You are a fixture.',
  tools: [],
}

let agentHome: string
let cwd: string
let sessionId: string

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'send-message-home-'))
  cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'send-message-cwd-')),
  )
  sessionId = `send-message-${Date.now()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  fs.rmSync(agentHome, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** A runAgent that answers like the real one: seeds the prompt, replies. */
function fakeRunAgent() {
  const seen: Message[][] = []
  const runAgent = vi.fn(async (prompt: string, options: AgentOptions) => {
    const messages = options.messages ?? []
    seen.push([...messages])
    const turn: Message[] = [
      { role: 'user', content: prompt, uuid: `u-${seen.length}` },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${seen.length}` }],
        uuid: `a-${seen.length}`,
      },
    ]
    for (const m of turn) {
      messages.push(m)
      options.onMessage?.(m)
    }
    return `answer ${seen.length}`
  })
  return { runAgent, seen }
}

function setup() {
  const registry = new ToolRegistry()
  registry.register(createTaskTool([fixtureAgent]))
  registry.register(createSendMessageTool())
  const { runAgent, seen } = fakeRunAgent()
  const context = {
    session: {
      id: sessionId,
      messages: [],
      createdAt: Date.now(),
      permissionMode: createDefaultPermissionMode(),
      agentType: null,
    },
    sessionId,
    cwd,
    eventBus: new EventBus(),
    wire: new WireEmitter({ emit: () => {} }, sessionId),
    registry,
    provider: { defaultModelId: () => 'fixture-model' },
    runAgent,
  } as unknown as ToolContext
  const run = (name: string, args: Record<string, unknown>) =>
    runWithRequestScope({ agentHome, cwd }, () =>
      (registry.get(name)!.create(cwd, context) as ExecutableTool).execute(
        args,
        { toolCallId: `call-${name}` },
      ),
    ) as Promise<ToolResult | string>
  return { run, seen }
}

describe('SendMessage', () => {
  it('continues a finished agent with its earlier messages', async () => {
    const { run, seen } = setup()
    const first = (await run('Agent', {
      subagent_type: 'fixture-agent',
      description: 'Audit routes',
      prompt: 'List the routes.',
    })) as ToolResult
    const agentId = /agentId: (\S+)/.exec(first.data.text)?.[1]
    expect(agentId).toBeTruthy()
    expect(
      readSidechain(sessionId, agentId!)?.messages.map(m => m.uuid),
    ).toEqual(['u-1', 'a-1'])

    const second = (await run('SendMessage', {
      to: agentId,
      message: 'Now count them.',
    })) as ToolResult
    expect(second.data.text).toMatch(/^answer 2/)
    expect(seen[1]!.map(m => m.uuid)).toEqual(['u-1', 'a-1'])
    expect(
      readSidechain(sessionId, agentId!)?.messages.map(m => m.uuid),
    ).toEqual(['u-1', 'a-1', 'u-2', 'a-2'])
  })

  it('refuses an agent it has no transcript for', async () => {
    const { run } = setup()
    expect(await run('SendMessage', { to: 'nope', message: 'hi' })).toMatch(
      /^Error: no transcript/,
    )
  })
})
