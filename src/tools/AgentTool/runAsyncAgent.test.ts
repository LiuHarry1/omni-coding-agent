import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { registerSessionLocation } from '../../session/paths.js'
import type { Message } from '../../core/types.js'
import {
  killAsyncAgent,
  registerAsyncAgent,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  dequeueAll,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import { _resetTaskOutputDirForTest } from '../../utils/task/diskOutput.js'
import { clearSessionTasks, getTask } from '../../utils/task/framework.js'
import {
  asyncAgentLaunchedText,
  describeToolActivity,
  renderAgentProgress,
  runAsyncAgentLifecycle,
} from './runAsyncAgent.js'

let agentHome: string
let sessionId: string

const assistant = (...content: unknown[]): Message =>
  ({ role: 'assistant', content }) as unknown as Message
const text = (value: string) => ({ type: 'text', text: value })
const toolCall = (toolName: string, input: unknown) => ({
  type: 'tool-call',
  toolCallId: `${toolName}-1`,
  toolName,
  input,
})

const launch = (): LocalAgentTaskState =>
  runWithRequestScope({ agentHome, cwd: '/workspace' }, () =>
    registerAsyncAgent({
      sessionId,
      description: 'Audit the routes',
      prompt: 'List every HTTP route.',
      agentType: 'Explore',
      toolUseId: 'call-1',
    }),
  )

const agentTask = (taskId: string) =>
  getTask(sessionId, taskId) as LocalAgentTaskState

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-async-agent-'))
  sessionId = `async-agent-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  vi.useRealTimers()
  clearSessionTasks(sessionId)
  resetCommandQueue()
  _resetTaskOutputDirForTest()
  fs.rmSync(agentHome, { recursive: true, force: true })
})

describe('describeToolActivity', () => {
  it('names the tool and what it was pointed at', () => {
    expect(describeToolActivity('Read', { file_path: 'src/a.ts' })).toBe(
      'Read src/a.ts',
    )
    expect(describeToolActivity('Grep', { pattern: 'TODO', path: 'src' })).toBe(
      'Grep src',
    )
    expect(
      describeToolActivity('Bash', { command: 'npm test\nnpm run lint' }),
    ).toBe('Bash npm test')
  })

  it('falls back to the tool name and keeps long input short', () => {
    expect(describeToolActivity('TodoWrite', { todos: [] })).toBe('TodoWrite')
    expect(describeToolActivity('TodoWrite', undefined)).toBe('TodoWrite')
    const long = describeToolActivity('Bash', { command: 'x'.repeat(500) })
    expect(long.length).toBeLessThanOrEqual('Bash '.length + 120)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('renderAgentProgress', () => {
  it('keeps what the agent said and one line per tool call', () => {
    const rendered = renderAgentProgress([
      { role: 'user', content: 'List every HTTP route.' } as Message,
      assistant(
        text('Looking at the router.'),
        toolCall('Read', { file_path: 'src/server/router.ts' }),
      ),
      { role: 'tool', content: [] } as unknown as Message,
      assistant(text('Found 12 routes.')),
    ])

    expect(rendered.text).toBe(
      'Looking at the router.\n[tool] Read src/server/router.ts\nFound 12 routes.\n',
    )
    expect(rendered.activities).toEqual(['Read src/server/router.ts'])
  })

  it('is empty when the agent has not spoken', () => {
    expect(renderAgentProgress([])).toEqual({ text: '', activities: [] })
  })
})

describe('runAsyncAgentLifecycle', () => {
  it('completes the task and reports back with the result and usage', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const task = launch()
    const eventBus = new EventBus()
    const messages: Message[] = []
    const cleanup = vi.fn()

    await runAsyncAgentLifecycle({
      task,
      eventBus,
      messages,
      cleanup,
      run: async onStepCommitted => {
        messages.push(
          assistant(
            text('Looking at the router.'),
            toolCall('Read', { file_path: 'src/server/router.ts' }),
          ),
        )
        eventBus.emit('usage', { inputTokens: 1000, outputTokens: 50 })
        onStepCommitted(messages)
        expect(agentTask(task.id).progress).toEqual({
          toolUseCount: 1,
          tokenCount: 1050,
          lastActivity: 'Read src/server/router.ts',
        })

        messages.push(assistant(text('Found 12 routes.')))
        eventBus.emit('usage', { inputTokens: 1400, outputTokens: 30 })
        vi.setSystemTime(1_015_000)
        return 'Found 12 routes.'
      },
    })

    expect(agentTask(task.id)).toMatchObject({
      status: 'completed',
      result: 'Found 12 routes.',
      notified: true,
    })
    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.value).toContain('<status>completed</status>')
    expect(queued[0]!.value).toContain('<result>Found 12 routes.</result>')
    // The last request's input plus everything written: 1400 + 50 + 30.
    expect(queued[0]!.value).toContain(
      '<usage><total_tokens>1480</total_tokens><tool_uses>1</tool_uses><duration_ms>15000</duration_ms></usage>',
    )
    expect(fs.readFileSync(task.outputFile, 'utf8')).toBe(
      'Agent (Explore): Audit the routes\n\n' +
        'Looking at the router.\n[tool] Read src/server/router.ts\n' +
        'Found 12 routes.\n' +
        '\n[completed]\n',
    )
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('falls back to the last thing the agent wrote when the run returns no text', async () => {
    const task = launch()
    const messages: Message[] = []

    await runAsyncAgentLifecycle({
      task,
      eventBus: new EventBus(),
      messages,
      run: async () => {
        messages.push(assistant(text('Nothing else to check.')))
        return '  '
      },
    })

    expect(agentTask(task.id).result).toBe('Nothing else to check.')
  })

  it('says so when the agent produced nothing at all', async () => {
    const task = launch()

    await runAsyncAgentLifecycle({
      task,
      eventBus: new EventBus(),
      messages: [],
      run: async () => '',
    })

    expect(agentTask(task.id).result).toMatch(/returned no output/)
  })

  it('reports a stopped agent with what it had found', async () => {
    const task = launch()
    const messages: Message[] = []
    const cleanup = vi.fn()

    await runAsyncAgentLifecycle({
      task,
      eventBus: new EventBus(),
      messages,
      cleanup,
      run: async () => {
        messages.push(assistant(text('Checked 4 of 9 files so far.')))
        killAsyncAgent(sessionId, task.id)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })

    expect(agentTask(task.id)).toMatchObject({
      status: 'killed',
      result: 'Checked 4 of 9 files so far.',
    })
    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.value).toContain('<status>killed</status>')
    expect(queued[0]!.value).toContain('was stopped</summary>')
    expect(queued[0]!.value).toContain(
      '<result>Checked 4 of 9 files so far.</result>',
    )
    expect(queued[0]!.value).not.toContain('<usage>')
    expect(fs.readFileSync(task.outputFile, 'utf8')).toContain('[stopped]')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('treats a run that returns after being stopped as stopped, not completed', async () => {
    const task = launch()

    await runAsyncAgentLifecycle({
      task,
      eventBus: new EventBus(),
      messages: [],
      run: async () => {
        killAsyncAgent(sessionId, task.id)
        return 'half an answer'
      },
    })

    expect(agentTask(task.id).status).toBe('killed')
    expect(dequeueAll(sessionId)[0]!.value).toContain('<status>killed</status>')
  })

  it('reports a failed agent with the error', async () => {
    const task = launch()
    const cleanup = vi.fn()

    await runAsyncAgentLifecycle({
      task,
      eventBus: new EventBus(),
      messages: [],
      cleanup,
      run: async () => {
        throw new Error('model overloaded')
      },
    })

    expect(agentTask(task.id)).toMatchObject({
      status: 'failed',
      error: 'model overloaded',
    })
    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.value).toContain('<status>failed</status>')
    expect(queued[0]!.value).toContain('failed: model overloaded</summary>')
    expect(fs.readFileSync(task.outputFile, 'utf8')).toContain(
      '[failed] model overloaded',
    )
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('does not let a failing cleanup escape', async () => {
    const task = launch()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      runAsyncAgentLifecycle({
        task,
        eventBus: new EventBus(),
        messages: [],
        run: async () => 'done',
        cleanup: () => {
          throw new Error('backend already gone')
        },
      }),
    ).resolves.toBeUndefined()

    expect(agentTask(task.id).status).toBe('completed')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('asyncAgentLaunchedText', () => {
  it('points at the output file where it can be read', () => {
    const launched = asyncAgentLaunchedText({
      agentId: 'a1b2c3d4e',
      outputFile: '/sessions/s1/tasks/a1b2c3d4e.output',
      canReadOutputFile: true,
    })

    expect(launched).toMatch(
      /^Async agent launched successfully\.\nagentId: a1b2c3d4e /,
    )
    expect(launched).toContain(
      'You will be notified automatically when it completes.',
    )
    expect(launched).toContain("Do not duplicate this agent's work")
    expect(launched).toContain(
      'output_file: /sessions/s1/tasks/a1b2c3d4e.output',
    )
  })

  it('leaves the file out where the model has no way to read it', () => {
    const launched = asyncAgentLaunchedText({
      agentId: 'a1b2c3d4e',
      outputFile: '/sessions/s1/tasks/a1b2c3d4e.output',
      canReadOutputFile: false,
    })

    expect(launched).not.toContain('output_file')
    expect(launched).toContain(
      'agent results will arrive in a subsequent message',
    )
  })
})
