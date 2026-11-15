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
  Session,
  ToolContext,
} from '../../core/types.js'
import { WireEmitter } from '../../core/wire-emitter.js'
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { stopTask } from '../../tasks/stopTask.js'
import {
  dequeueAll,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import {
  _resetTaskOutputDirForTest,
  setTaskSessionId,
} from '../../utils/task/diskOutput.js'
import {
  clearSessionTasks,
  getTask,
  listSessionTasks,
  registerTask,
} from '../../utils/task/framework.js'
import { createTaskStateBase } from '../../Task.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { createTaskTool } from './AgentTool.js'

type ExecutableTool = AnyTool & {
  execute: (input: unknown, options?: unknown) => Promise<unknown>
}
type ToolResult = { data: { text: string; ui?: unknown } }

const fixtureAgent: AgentDefinition = {
  agentType: 'fixture-agent',
  whenToUse: 'Tests',
  description: 'Deterministic fixture agent',
  systemPrompt: 'You are a fixture.',
  tools: ['ReadFixture'],
}

const input = {
  subagent_type: 'fixture-agent',
  description: 'Audit the routes',
  prompt: 'List every HTTP route.',
}

let agentHome: string
let cwd: string
let sessionId: string

/** A run the test finishes by hand. */
function pendingRun() {
  const calls: Array<{ prompt: string; options: AgentOptions }> = []
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  const runAgent = vi.fn((prompt: string, options: AgentOptions) => {
    calls.push({ prompt, options })
    return new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
      options.abortSignal?.addEventListener('abort', () =>
        rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      )
    })
  })
  return {
    runAgent,
    calls,
    finish: (text: string) => resolve(text),
    fail: (error: Error) => reject(error),
  }
}

function setup(overrides: Partial<ToolContext> = {}) {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ReadFixture',
    description: 'Fixture read',
    create: () => ({ description: 'fixture read' }) as AnyTool,
  })
  const session: Session = {
    id: sessionId,
    messages: [],
    createdAt: Date.now(),
    permissionMode: createDefaultPermissionMode(),
    agentType: null,
  }
  const emitted: unknown[] = []
  const run = pendingRun()
  const context = {
    session,
    sessionId,
    cwd,
    eventBus: new EventBus(),
    wire: new WireEmitter(
      { emit: message => emitted.push(message) },
      sessionId,
    ),
    registry,
    provider: { defaultModelId: () => 'fixture-model' },
    runAgent: run.runAgent,
    ...overrides,
  } as unknown as ToolContext
  const tool = createTaskTool([fixtureAgent]).create(
    cwd,
    context,
  ) as ExecutableTool
  const execute = (args: Record<string, unknown>) =>
    runWithRequestScope({ agentHome, cwd }, () =>
      tool.execute(args, { toolCallId: 'call-1' }),
    )
  return { context, emitted, execute, ...run }
}

const tasks = () => listSessionTasks(sessionId) as LocalAgentTaskState[]

/** Let the detached lifecycle run to its end. */
const settled = () => vi.waitFor(() => expect(tasks()[0]?.notified).toBe(true))

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-agent-bg-home-'))
  cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'omni-agent-bg-cwd-')),
  )
  sessionId = `agent-bg-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  clearSessionTasks(sessionId)
  resetCommandQueue()
  _resetTaskOutputDirForTest()
  fs.rmSync(agentHome, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('Agent tool: run_in_background', () => {
  it('returns as soon as the agent is launched and reports back when it is done', async () => {
    const { execute, calls, finish } = setup()

    const result = (await execute({
      ...input,
      run_in_background: true,
    })) as ToolResult

    // The agent is still working.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toBe('List every HTTP route.')
    const [task] = tasks()
    expect(task).toMatchObject({
      type: 'local_agent',
      status: 'running',
      description: 'Audit the routes',
      prompt: 'List every HTTP route.',
      agentType: 'fixture-agent',
      toolUseId: 'call-1',
    })
    expect(result.data.text).toMatch(/^Async agent launched successfully\./)
    expect(result.data.text).toContain(`agentId: ${task!.id} `)
    expect(result.data.text).toContain(`output_file: ${task!.outputFile}`)
    expect(result.data.ui).toBeUndefined()
    expect(dequeueAll(sessionId)).toEqual([])

    finish('Found 12 routes.')
    await settled()

    expect(tasks()[0]).toMatchObject({
      status: 'completed',
      result: 'Found 12 routes.',
    })
    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.mode).toBe('task-notification')
    expect(queued[0]!.value).toContain(
      '<summary>Agent &quot;Audit the routes&quot; completed</summary>',
    )
    expect(queued[0]!.value).toContain('<result>Found 12 routes.</result>')
  })

  it('gives the agent nothing that ends with the turn', async () => {
    const turnGate = vi.fn(async () => ({ behavior: 'allow' as const }))
    const turnAbort = new AbortController()
    const { context, emitted, calls, finish } = setup({
      canUseTool: turnGate,
    })
    const tool = createTaskTool([fixtureAgent]).create(
      cwd,
      context,
    ) as ExecutableTool

    await runWithRequestScope({ agentHome, cwd }, () =>
      tool.execute(
        { ...input, run_in_background: true },
        { toolCallId: 'call-1', abortSignal: turnAbort.signal },
      ),
    )

    const { options } = calls[0]!
    const [task] = tasks()
    // Stopping the turn does not stop the agent.
    expect(options.abortSignal).toBe(task!.abortController!.signal)
    turnAbort.abort()
    expect(options.abortSignal!.aborted).toBe(false)
    // Its usage is reported on a bus of its own, its events go nowhere, and
    // it cannot put a permission prompt in front of the user.
    expect(options.eventBus).not.toBe(context.eventBus)
    expect(options.wire).not.toBe(context.wire)
    expect(emitted).toEqual([])
    expect(options.canUseTool).toBeTypeOf('function')
    expect(options.canUseTool).not.toBe(turnGate)
    // Messages addressed to it reach it.
    expect(options.agentId).toBe(task!.id)

    finish('done')
    await settled()
  })

  it('works on a backend of its own and releases it when it is done', async () => {
    const forked = { kind: 'worker', dispose: vi.fn() }
    const turnBackend = {
      kind: 'worker',
      dispose: vi.fn(),
      fork: vi.fn(() => forked),
    } as unknown as ExecutionBackend
    const seen: Array<ToolContext['execution']> = []
    const { context, execute, finish } = setup({ execution: turnBackend })
    const createAll = vi.spyOn(context.registry!, 'createAll')

    await execute({ ...input, run_in_background: true })
    seen.push(createAll.mock.calls[0]![1].execution)

    expect(seen[0]).toBe(forked)
    expect(forked.dispose).not.toHaveBeenCalled()

    finish('done')
    await settled()
    await vi.waitFor(() => expect(forked.dispose).toHaveBeenCalledTimes(1))
    expect(turnBackend.dispose).not.toHaveBeenCalled()
  })

  it('has the host account for what the agent uses after the turn', async () => {
    const settle = vi.fn()
    const accountBackgroundUsage = vi.fn(() => settle)
    const { execute, calls, finish } = setup({ accountBackgroundUsage })

    await execute({ ...input, run_in_background: true })

    expect(accountBackgroundUsage).toHaveBeenCalledWith(
      calls[0]!.options.eventBus,
    )
    expect(settle).not.toHaveBeenCalled()

    finish('done')
    await settled()
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
  })

  it('stops when its task is stopped, and reports that', async () => {
    const { execute } = setup()
    await execute({ ...input, run_in_background: true })
    const [task] = tasks()

    await stopTask(sessionId, task!.id)
    await settled()

    expect(tasks()[0]!.status).toBe('killed')
    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.value).toContain('<status>killed</status>')
  })

  it('reports an agent that failed', async () => {
    const { execute, fail } = setup()
    await execute({ ...input, run_in_background: true })

    fail(new Error('model overloaded'))
    await settled()

    expect(tasks()[0]).toMatchObject({
      status: 'failed',
      error: 'model overloaded',
    })
    expect(dequeueAll(sessionId)[0]!.value).toContain(
      'failed: model overloaded</summary>',
    )
  })

  it('leaves the output file out of its answer in a remote workspace', async () => {
    const { context, execute, finish } = setup()
    context.session!.workspace = {
      environmentId: 'ssh:box',
      cwd: '/srv/app',
    } as Session['workspace']

    const result = (await execute({
      ...input,
      run_in_background: true,
    })) as ToolResult

    expect(result.data.text).not.toContain('output_file')
    finish('done')
    await settled()
  })
})

describe('Agent tool: what a subagent starts', () => {
  /** A background shell registered as if the subagent's Bash had started it. */
  const shellStartedBy = (agentId: string): string => {
    const task: LocalShellTaskState = {
      ...runWithRequestScope({ agentHome, cwd }, () => {
        setTaskSessionId(sessionId)
        return createTaskStateBase('bshell0001', 'local_bash', 'sleep 60')
      }),
      type: 'local_bash',
      status: 'running',
      command: 'sleep 60',
      completionStatusSentInAttachment: false,
      shell: 'bash',
      sessionId,
      cwd,
      isBackgrounded: true,
      agentId,
    }
    registerTask(sessionId, task)
    return task.id
  }

  it.each([
    ['in the foreground', {}],
    ['in the background', { run_in_background: true }],
  ])('is stopped when the subagent %s exits', async (_where, extra) => {
    const { context, execute, calls, finish } = setup()
    const createAll = vi.spyOn(context.registry!, 'createAll')

    const pending = execute({ ...input, ...extra })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const agentId = createAll.mock.calls[0]![1].agentId!
    expect(agentId).toMatch(/^a[0-9a-z]{8}$/)
    expect(calls[0]!.options.agentId).toBe(agentId)
    const shellId = shellStartedBy(agentId)

    finish('done')
    await pending
    await vi.waitFor(() =>
      expect(getTask(sessionId, shellId)?.status).toBe('killed'),
    )
  })
})

describe('Agent tool: where it cannot run in the background', () => {
  it('runs in the foreground without a session to report back to', async () => {
    const { execute, calls, finish } = setup({ sessionId: undefined })

    const pending = execute({ ...input, run_in_background: true })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    finish('Found 12 routes.')

    expect(((await pending) as ToolResult).data.text).toBe('Found 12 routes.')
    expect(tasks()).toEqual([])
  })

  it('runs in the foreground on a backend that ends with the turn', async () => {
    const turnBackend = { kind: 'worker' } as unknown as ExecutionBackend
    const { execute, calls, finish } = setup({ execution: turnBackend })

    const pending = execute({ ...input, run_in_background: true })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    finish('Found 12 routes.')

    expect(((await pending) as ToolResult).data.text).toMatch(
      /^Found 12 routes\.\n\nagentId: /,
    )
    expect(tasks()).toEqual([])
  })

  it('still runs in the foreground when not asked otherwise', async () => {
    const { context, emitted, execute, calls, finish } = setup()

    const pending = execute(input)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.options.eventBus).toBe(context.eventBus)
    expect(emitted.length).toBeGreaterThan(0)
    finish('Found 12 routes.')

    expect(((await pending) as ToolResult).data.text).toMatch(
      /^Found 12 routes\.\n\nagentId: /,
    )
    expect(tasks()).toEqual([])
    expect(dequeueAll(sessionId)).toEqual([])
  })
})
