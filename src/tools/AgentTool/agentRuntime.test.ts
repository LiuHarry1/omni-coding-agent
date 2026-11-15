import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { createDefaultPermissionMode } from '../../core/permission-mode.js'
import { registerSessionLocation } from '../../core/session-paths.js'
import { ToolRegistry } from '../../core/tool-registry.js'
import type {
  AgentDefinition,
  AgentOptions,
  AnyTool,
  ToolContext,
} from '../../core/types.js'
import { WireEmitter } from '../../core/wire-emitter.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { readSidechain } from '../../session/sidechain.js'
import { MCPManager } from '../../core/mcp-manager.js'
import { createTaskTool } from './AgentTool.js'
import { connectAgentMcp } from './agentRuntime.js'

type ExecutableTool = AnyTool & {
  execute: (input: unknown, options?: unknown) => Promise<unknown>
}
type ToolResult = { data: { text: string } }

let agentHome: string
let repo: string
let sessionId: string

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-home-'))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-')))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  sessionId = `agent-rt-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  fs.rmSync(agentHome, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

function setup(
  def: Partial<AgentDefinition>,
  runAgent: (prompt: string, options: AgentOptions) => Promise<string>,
) {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ReadFixture',
    description: 'read',
    isReadOnly: () => true,
    create: () => ({ description: 'read' }) as AnyTool,
  })
  registry.register({
    name: 'WriteFixture',
    description: 'write',
    create: () => ({ description: 'write' }) as AnyTool,
  })
  const agent: AgentDefinition = {
    agentType: 'fixture-agent',
    whenToUse: 'Tests',
    description: 'Fixture',
    systemPrompt: 'You are a fixture.',
    tools: ['ReadFixture', 'WriteFixture'],
    ...def,
  }
  const context = {
    session: {
      id: sessionId,
      messages: [],
      createdAt: Date.now(),
      permissionMode: createDefaultPermissionMode(),
      agentType: null,
    },
    sessionId,
    cwd: repo,
    eventBus: new EventBus(),
    wire: new WireEmitter({ emit: () => {} }, sessionId),
    registry,
    provider: { defaultModelId: () => 'fixture-model' },
    canUseTool: async () => ({ behavior: 'allow' as const }),
    runAgent: vi.fn(runAgent),
  } as unknown as ToolContext
  const tool = createTaskTool([agent]).create(repo, context) as ExecutableTool
  return (args: Record<string, unknown> = {}) =>
    runWithRequestScope({ agentHome, cwd: repo }, () =>
      tool.execute(
        {
          subagent_type: 'fixture-agent',
          description: 'Edit a file',
          prompt: 'Change a.txt',
          ...args,
        },
        { toolCallId: 'call-1' },
      ),
    ) as Promise<ToolResult>
}

describe('agent definitions at run time', () => {
  it('isolation: worktree runs the agent in a worktree and reports kept changes', async () => {
    let agentCwd = ''
    const run = setup({ isolation: 'worktree' }, async (_prompt, options) => {
      agentCwd = options.cwd!
      fs.writeFileSync(path.join(agentCwd, 'a.txt'), 'changed\n')
      return 'Done.'
    })
    const result = await run()
    expect(agentCwd).not.toBe(repo)
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('original\n')
    expect(result.data.text).toContain(`its changes are in ${agentCwd}`)
    const agentId = /agentId: (\S+)/.exec(result.data.text)![1]!
    expect(readSidechain(sessionId, agentId)?.meta?.worktree?.path).toBe(
      agentCwd,
    )
  })

  it('isolation: worktree removes a worktree the agent left alone', async () => {
    let agentCwd = ''
    const run = setup({ isolation: 'worktree' }, async (_prompt, options) => {
      agentCwd = options.cwd!
      return 'Nothing to change.'
    })
    const result = await run()
    expect(fs.existsSync(agentCwd)).toBe(false)
    expect(result.data.text).not.toContain('worktree')
  })

  it('permissionMode: ask keeps the agent to read-only tools', async () => {
    const decisions: string[] = []
    const run = setup({ permissionMode: 'ask' }, async (_prompt, options) => {
      for (const name of ['ReadFixture', 'WriteFixture']) {
        const d = await options.canUseTool!(name, {}, { toolUseId: name })
        decisions.push(`${name}:${d.behavior}`)
      }
      return 'ok'
    })
    await run()
    expect(decisions).toEqual(['ReadFixture:allow', 'WriteFixture:deny'])
  })

  it('background: true runs in the background without being asked', async () => {
    const run = setup({ background: true }, async () => 'later')
    const result = await run()
    expect(result.data.text).toMatch(/^Async agent launched successfully\./)
  })
})

describe('connectAgentMcp', () => {
  const tool = { description: 't' } as AnyTool
  let addServer: ReturnType<typeof vi.spyOn>
  let closeAll: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    addServer = vi
      .spyOn(MCPManager.prototype, 'addServer')
      .mockResolvedValue(undefined)
    closeAll = vi
      .spyOn(MCPManager.prototype, 'closeAll')
      .mockResolvedValue(undefined)
    vi.spyOn(MCPManager.prototype, 'getAllTools').mockReturnValue({
      remote_t: tool,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('connects an inline server for the run and closes it afterwards', async () => {
    const config = { command: 'npx', args: ['fake-mcp'] }
    const result = await connectAgentMcp([{ local: config }])

    expect(addServer).toHaveBeenCalledExactlyOnceWith('local', config)
    expect(result.tools).toEqual({ remote_t: tool })
    expect(closeAll).not.toHaveBeenCalled()

    await result.close()
    expect(closeAll).toHaveBeenCalledOnce()
  })

  it('starts a stdio server when sign-in is on, as session MCP does', async () => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    const config = { command: 'npx', args: ['fake-mcp'] }
    await connectAgentMcp([{ local: config }])
    expect(addServer).toHaveBeenCalledExactlyOnceWith('local', config)
  })

  it('connects only HTTP servers with cloud workspaces, as session MCP does', async () => {
    vi.stubEnv('CLOUD_WORKSPACES', 'docker')
    const config = {
      url: 'https://example.com/mcp',
      transport: 'http' as const,
    }
    const result = await connectAgentMcp([
      { local: { command: 'npx' } },
      { remote: config },
    ])
    expect(addServer).toHaveBeenCalledExactlyOnceWith('remote', config)
    expect(result.tools).toEqual({ remote_t: tool })
  })

  it("uses the session's connection for a named server and leaves it open", async () => {
    const sessionTool = { description: 's' } as AnyTool
    const result = await connectAgentMcp(['docs'], { docs_search: sessionTool })
    expect(result.tools).toEqual({ docs_search: sessionTool })

    await result.close()
    expect(addServer).not.toHaveBeenCalled()
    expect(closeAll).not.toHaveBeenCalled()
  })
})
