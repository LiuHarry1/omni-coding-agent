import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
} from './runtime-protocol.js'
import type { RuntimePort } from './types.js'
import { WorkerExecutionBackend } from './worker-execution-backend.js'
import { WorkerChannelLostError } from './worker-channel-error.js'
import { registerSessionLocation } from '../core/session-paths.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import { spawnShellTask } from '../tasks/LocalShellTask/LocalShellTask.js'
import { clearSessionTasks, getTask } from '../utils/task/framework.js'
import { drainTaskNotifications } from '../utils/task/pendingNotifications.js'
import type { ExecutionBackend } from './execution-backend.js'
import {
  _resetTaskOutputDirForTest,
  setTaskSessionId,
} from '../utils/task/diskOutput.js'

class FakeRuntime implements RuntimePort {
  readonly workspace = { environmentId: 'ssh:test', cwd: '/workspace' }
  readonly messages: RuntimeClientMessage[] = []
  private readonly events = new EventEmitter()
  closed = false

  send(message: RuntimeClientMessage): void {
    if (this.closed) throw new WorkerChannelLostError('fake runtime closed')
    this.messages.push(message)
  }

  onMessage(handler: (message: RuntimeServerMessage) => void): () => void {
    this.events.on('message', handler)
    return () => this.events.off('message', handler)
  }

  emit(message: RuntimeServerMessage): void {
    this.events.emit('message', message)
  }

  interrupt(): void {}

  async close(): Promise<void> {
    this.closed = true
  }

  async health(): Promise<'ok' | 'dead'> {
    return this.closed ? 'dead' : 'ok'
  }
}

describe('Worker channel loss', () => {
  let agentHome: string
  let sessionId: string

  beforeEach(() => {
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-loss-'))
    sessionId = `worker-loss-${Date.now()}-${Math.random()}`
    registerSessionLocation(sessionId, {
      projectKey: 'project',
      agentHome,
    })
    setTaskSessionId(sessionId)
    clearSessionTasks(sessionId)
  })

  afterEach(() => {
    vi.useRealTimers()
    clearSessionTasks(sessionId)
    _resetTaskOutputDirForTest()
    fs.rmSync(agentHome, { recursive: true, force: true })
  })

  it('rejects all pending and future RPCs immediately', async () => {
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace',
    )
    const first = backend.writeText('/workspace/a.txt', 'a')
    const second = backend.exists('/workspace/a.txt')

    runtime.emit({ type: 'error', message: 'ssh channel closed' })

    await expect(first).rejects.toBeInstanceOf(WorkerChannelLostError)
    await expect(second).rejects.toBeInstanceOf(WorkerChannelLostError)
    await expect(backend.readText('/workspace/a.txt')).rejects.toBeInstanceOf(
      WorkerChannelLostError,
    )
    backend.dispose()
  })

  it('marks a background command unknown instead of polling forever', async () => {
    const execution = {
      kind: 'worker',
      environmentId: 'ssh:test',
      execBgStart: async () => ({ pid: 42 }),
      execBgPoll: async () => {
        throw new WorkerChannelLostError('worker disappeared')
      },
    } as unknown as ExecutionBackend

    await runWithRequestScope({ agentHome, cwd: '/workspace' }, async () => {
      const handle = await spawnShellTask(
        {
          command: 'deploy-side-effect',
          description: 'deployment',
          sessionId,
          cwd: '/workspace',
        },
        { execution },
      )

      await vi.waitFor(
        () => {
          expect(getTask(sessionId, handle.taskId)?.status).toBe('unknown')
        },
        { timeout: 2_000, interval: 50 },
      )
      const task = getTask(sessionId, handle.taskId)
      expect(task && 'result' in task ? task.result : undefined).toMatchObject({
        code: null,
        interrupted: true,
        reason: 'worker_lost',
      })
      const notifications = drainTaskNotifications(sessionId)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.status).toBe('unknown')
      expect(notifications[0]?.summary).toContain('inspect its effects')
    })
  })

  it('cancels foreground exec by its original request id and waits for settlement', async () => {
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace',
    )
    const controller = new AbortController()
    const execution = backend.exec('sleep 90', {
      cwd: '/workspace',
      signal: controller.signal,
    })
    const original = runtime.messages[0]
    expect(original).toMatchObject({
      type: 'fs_op',
      op: { op: 'exec', command: 'sleep 90' },
    })
    if (original?.type !== 'fs_op') throw new Error('exec request missing')

    controller.abort()
    expect(runtime.messages[1]).toMatchObject({
      type: 'fs_op',
      op: {
        op: 'exec_cancel',
        targetRequestId: original.requestId,
      },
    })
    expect(runtime.closed).toBe(false)

    runtime.emit({
      type: 'fs_op_result',
      requestId: original.requestId,
      ok: true,
      data: {
        stdout: '',
        stderr: '',
        code: null,
        interrupted: true,
      },
    })
    await expect(execution).resolves.toMatchObject({ interrupted: true })
    expect(runtime.closed).toBe(false)
    backend.dispose()
  })

  it('fails and closes an unresponsive Worker five seconds after cancel', async () => {
    vi.useFakeTimers()
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace',
    )
    const controller = new AbortController()
    const execution = backend.exec('stuck-command', {
      cwd: '/workspace',
      signal: controller.signal,
    })
    const rejected = expect(execution).rejects.toBeInstanceOf(
      WorkerChannelLostError,
    )

    controller.abort()
    await vi.advanceTimersByTimeAsync(5_001)

    await rejected
    expect(runtime.closed).toBe(true)
    backend.dispose()
  })
})
