import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSessionLocation } from '../../session/paths.js'
import {
  dequeueAll,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import { _resetTaskOutputDirForTest } from '../../utils/task/diskOutput.js'
import {
  clearSessionTasks,
  getTask,
  listRunningTasks,
} from '../../utils/task/framework.js'
import { stopTask } from '../stopTask.js'
import {
  completeAsyncAgent,
  enqueueAgentNotification,
  failAsyncAgent,
  isLocalAgentTask,
  killAsyncAgent,
  registerAsyncAgent,
  updateAsyncAgentProgress,
  type LocalAgentTaskState,
} from './LocalAgentTask.js'

let agentHome: string
let sessionId: string

const inScope = <T>(fn: () => T): T =>
  runWithRequestScope({ agentHome, cwd: '/workspace' }, fn)

const launch = (description = 'Audit the routes') =>
  inScope(() =>
    registerAsyncAgent({
      sessionId,
      description,
      prompt: 'List every HTTP route.',
      agentType: 'Explore',
      toolUseId: 'call-1',
    }),
  )

const agentTask = (taskId: string) =>
  getTask(sessionId, taskId) as LocalAgentTaskState

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-agent-task-'))
  sessionId = `agent-task-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  clearSessionTasks(sessionId)
  resetCommandQueue()
  _resetTaskOutputDirForTest()
  fs.rmSync(agentHome, { recursive: true, force: true })
})

describe('a background agent task', () => {
  it('is registered running, with an id of its own kind and an output file', () => {
    const task = launch()

    expect(task.id).toMatch(/^a[0-9a-z]{8}$/)
    expect(task.agentId).toBe(task.id)
    expect(isLocalAgentTask(getTask(sessionId, task.id))).toBe(true)
    expect(task).toMatchObject({
      type: 'local_agent',
      status: 'running',
      description: 'Audit the routes',
      prompt: 'List every HTTP route.',
      agentType: 'Explore',
      toolUseId: 'call-1',
      notified: false,
    })
    expect(fs.existsSync(task.outputFile)).toBe(true)
    expect(listRunningTasks(sessionId).map(t => t.id)).toEqual([task.id])
  })

  it('keeps its progress while it runs', () => {
    const task = launch()

    updateAsyncAgentProgress(sessionId, task.id, {
      toolUseCount: 2,
      tokenCount: 900,
      lastActivity: 'Read src/server/router.ts',
    })

    expect(agentTask(task.id).progress).toEqual({
      toolUseCount: 2,
      tokenCount: 900,
      lastActivity: 'Read src/server/router.ts',
    })
  })

  it('completes with its report', () => {
    const task = launch()

    completeAsyncAgent(sessionId, task.id, 'Found 12 routes.')

    expect(agentTask(task.id)).toMatchObject({
      status: 'completed',
      result: 'Found 12 routes.',
      abortController: undefined,
    })
    expect(agentTask(task.id).endTime).toBeTypeOf('number')
    expect(listRunningTasks(sessionId)).toEqual([])
  })

  it('fails with the error', () => {
    const task = launch()

    failAsyncAgent(sessionId, task.id, 'model overloaded')

    expect(agentTask(task.id)).toMatchObject({
      status: 'failed',
      error: 'model overloaded',
    })
  })

  it('aborts its run when it is stopped', () => {
    const task = launch()
    const signal = task.abortController!.signal

    killAsyncAgent(sessionId, task.id)

    expect(signal.aborted).toBe(true)
    expect(agentTask(task.id)).toMatchObject({
      status: 'killed',
      abortController: undefined,
    })
  })

  it('stays as it ended when a stop or a late result comes afterwards', () => {
    const task = launch()
    completeAsyncAgent(sessionId, task.id, 'Found 12 routes.')

    killAsyncAgent(sessionId, task.id)
    failAsyncAgent(sessionId, task.id, 'too late')

    expect(agentTask(task.id)).toMatchObject({
      status: 'completed',
      result: 'Found 12 routes.',
    })
  })

  it('takes what the agent had written once its stopped run has unwound', () => {
    const task = launch()
    killAsyncAgent(sessionId, task.id)

    killAsyncAgent(sessionId, task.id, 'Checked 4 of 9 files so far.')

    expect(agentTask(task.id)).toMatchObject({
      status: 'killed',
      result: 'Checked 4 of 9 files so far.',
    })
  })
})

describe('a background agent notification', () => {
  it('carries the report and what the run cost', () => {
    const task = launch()
    completeAsyncAgent(sessionId, task.id, 'Found 12 routes.')

    enqueueAgentNotification({
      sessionId,
      taskId: task.id,
      description: task.description,
      status: 'completed',
      finalMessage: 'Found 12 routes.',
      usage: { totalTokens: 4200, toolUses: 7, durationMs: 15000 },
      toolUseId: 'call-1',
    })

    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      mode: 'task-notification',
      priority: 'later',
    })
    expect(queued[0]!.value).toBe(`<task-notification>
<task-id>${task.id}</task-id>
<tool-use-id>call-1</tool-use-id>
<output-file>${task.outputFile}</output-file>
<status>completed</status>
<summary>Agent &quot;Audit the routes&quot; completed</summary>
<result>Found 12 routes.</result>
<usage><total_tokens>4200</total_tokens><tool_uses>7</tool_uses><duration_ms>15000</duration_ms></usage>
</task-notification>`)
  })

  it('names the error of a failed agent', () => {
    const task = launch()

    enqueueAgentNotification({
      sessionId,
      taskId: task.id,
      description: task.description,
      status: 'failed',
      error: 'model overloaded',
    })

    const [queued] = dequeueAll(sessionId)
    expect(queued!.value).toContain('<status>failed</status>')
    expect(queued!.value).toContain(
      '<summary>Agent &quot;Audit the routes&quot; failed: model overloaded</summary>',
    )
    expect(queued!.value).not.toContain('<result>')
    expect(queued!.value).not.toContain('<usage>')
  })

  it('is sent once per task', () => {
    const task = launch()
    const notify = () =>
      enqueueAgentNotification({
        sessionId,
        taskId: task.id,
        description: task.description,
        status: 'killed',
      })

    notify()
    notify()

    const queued = dequeueAll(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.value).toContain(
      '<summary>Agent &quot;Audit the routes&quot; was stopped</summary>',
    )
    expect(agentTask(task.id).notified).toBe(true)
  })

  it('is not sent for a task that no longer exists', () => {
    const task = launch()
    clearSessionTasks(sessionId)

    enqueueAgentNotification({
      sessionId,
      taskId: task.id,
      description: task.description,
      status: 'completed',
    })

    expect(dequeueAll(sessionId)).toEqual([])
  })
})

describe('stopTask on a background agent', () => {
  it('stops it and leaves the notification to the agent itself', async () => {
    const task = launch()
    const signal = task.abortController!.signal

    await expect(stopTask(sessionId, task.id)).resolves.toEqual({
      message: 'Agent "Audit the routes" was stopped',
    })

    expect(signal.aborted).toBe(true)
    expect(agentTask(task.id)).toMatchObject({
      status: 'killed',
      notified: false,
    })
  })

  it('says so when the agent had already finished', async () => {
    const task = launch()
    completeAsyncAgent(sessionId, task.id, 'Found 12 routes.')

    await expect(stopTask(sessionId, task.id)).resolves.toEqual({
      message: `Task ${task.id} already finished (completed).`,
    })
  })
})
