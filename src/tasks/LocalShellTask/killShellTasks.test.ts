import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSessionLocation } from '../../core/session-paths.js'
import {
  dequeueAll,
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { _resetTaskOutputDirForTest } from '../../utils/task/diskOutput.js'
import { clearSessionTasks, getTask } from '../../utils/task/framework.js'
import { killShellTasksForAgent } from './killShellTasks.js'
import { spawnShellTask } from './LocalShellTask.js'

let agentHome: string
let sessionId: string

const spawn = (command: string, agentId?: string) =>
  runWithRequestScope({ agentHome, cwd: process.cwd() }, () =>
    spawnShellTask({
      command,
      description: command,
      sessionId,
      cwd: process.cwd(),
      agentId,
    }),
  )

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-kill-agent-'))
  sessionId = `kill-agent-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(async () => {
  for (const id of ['a1', 'a2']) killShellTasksForAgent(sessionId, id)
  clearSessionTasks(sessionId)
  resetCommandQueue()
  _resetTaskOutputDirForTest()
  fs.rmSync(agentHome, { recursive: true, force: true })
})

describe('background shells started by a subagent', () => {
  it('are reported to that agent, not to the main thread', async () => {
    const handle = await spawn('true', 'a1')

    await vi.waitFor(
      () => expect(getTask(sessionId, handle.taskId)?.status).toBe('completed'),
      { timeout: 3_000 },
    )
    const [notification] = dequeueAll(sessionId)
    expect(notification).toMatchObject({
      mode: 'task-notification',
      agentId: 'a1',
    })
  })

  it('are stopped when the agent exits, with no notification', async () => {
    const own = await spawn('sleep 30', 'a1')
    const otherAgent = await spawn('sleep 30', 'a2')
    const mainThread = await spawn('sleep 30')

    killShellTasksForAgent(sessionId, 'a1')

    expect(getTask(sessionId, own.taskId)).toMatchObject({
      status: 'killed',
      notified: true,
    })
    expect(getTask(sessionId, otherAgent.taskId)?.status).toBe('running')
    expect(getTask(sessionId, mainThread.taskId)?.status).toBe('running')
    killShellTasksForAgent(sessionId, 'a2')
    mainThread.cleanup?.()
  })

  it('leave nothing queued for the agent once it has exited', () => {
    enqueuePendingNotification(sessionId, {
      value: '<task-notification>for a1</task-notification>',
      mode: 'task-notification',
      agentId: 'a1',
    })
    enqueue(sessionId, { value: 'for the main thread', mode: 'prompt' })
    enqueue(sessionId, { value: 'for a2', mode: 'prompt', agentId: 'a2' })

    killShellTasksForAgent(sessionId, 'a1')

    expect(getCommandQueue(sessionId).map(cmd => cmd.value)).toEqual([
      'for the main thread',
      'for a2',
    ])
  })
})
