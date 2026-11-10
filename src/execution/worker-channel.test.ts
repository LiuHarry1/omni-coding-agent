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

  it('keeps caller execution cwd inside the bound workspace root', () => {
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      new FakeRuntime(),
      'posix',
      '/workspace',
    )
    expect(backend.resolve('/workspace/packages/web', 'src/app.ts')).toBe(
      '/workspace/packages/web/src/app.ts',
    )
    backend.assertInWorkspace(
      '/workspace/packages/web',
      '/workspace/README.md',
      'read',
    )
    expect(() => backend.resolve('/workspace-other', 'secret.txt')).toThrow(
      /Workspace context mismatch/,
    )
    backend.dispose()
  })

  it('does not persist a Skill directory outside the workspace as shell cwd', async () => {
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace/repo',
    )
    const command = backend.exec('cd /workspace/users/test/.ai-agent/skills/x', {
      cwd: '/workspace/repo',
    })
    const request = runtime.messages.at(-1)
    expect(request?.type).toBe('fs_op')
    if (!request || request.type !== 'fs_op') throw new Error('missing fs_op')
    runtime.emit({
      type: 'fs_op_result',
      requestId: request.requestId,
      ok: true,
      data: {
        stdout: '',
        stderr: '',
        code: 0,
        cwdAfter: '/workspace/users/test/.ai-agent/skills/x',
      },
    })

    await expect(command).resolves.toMatchObject({
      code: 0,
      cwdAfter: '/workspace/repo',
    })
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

  it('marks a missing Worker background task unknown', async () => {
    const execution = {
      kind: 'worker',
      environmentId: 'ssh:test',
      execBgStart: async () => ({ pid: 42 }),
      execBgPoll: async () => ({
        done: true,
        exitCode: null,
        unknown: true,
      }),
    } as unknown as ExecutionBackend

    await runWithRequestScope({ agentHome, cwd: '/workspace' }, async () => {
      const handle = await spawnShellTask(
        {
          command: 'lost-side-effect',
          description: 'lost task',
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
        reason: 'task_missing',
      })
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

  it('fails only the unresponsive request five seconds after cancel', async () => {
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
    const rejected = expect(execution).rejects.toThrow(
      'Worker exec cancellation timed out',
    )

    controller.abort()
    await vi.advanceTimersByTimeAsync(5_001)

    await rejected
    expect(runtime.closed).toBe(false)
    const next = backend.exists('/workspace/still-usable')
    const request = runtime.messages.at(-1)
    if (request?.type !== 'fs_op') throw new Error('next request missing')
    runtime.emit({
      type: 'fs_op_result',
      requestId: request.requestId,
      ok: true,
      data: true,
    })
    await expect(next).resolves.toBe(true)
    backend.dispose()
  })

  it('cancels a foreground exec in the Worker when its request times out', async () => {
    vi.useFakeTimers()
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace',
    )
    const execution = backend.exec('slow-command', {
      cwd: '/workspace',
      timeoutMs: 1_000,
    })
    const rejected = expect(execution).rejects.toThrow(
      'Worker fs_op timed out: exec',
    )
    const request = runtime.messages.at(-1)
    if (request?.type !== 'fs_op') throw new Error('exec request missing')

    await vi.advanceTimersByTimeAsync(11_001)

    await rejected
    expect(runtime.messages.at(-1)).toMatchObject({
      type: 'fs_op',
      op: { op: 'exec_cancel', targetRequestId: request.requestId },
    })
    expect(runtime.closed).toBe(false)
    backend.dispose()
  })

  it('recycles the channel after consecutive timeouts with no Worker response', async () => {
    vi.useFakeTimers()
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace',
    )
    const requests = [1, 2, 3].map(n => {
      const execution = backend.exec(`hung-${n}`, {
        cwd: '/workspace',
        timeoutMs: 1_000,
      })
      return expect(execution).rejects.toThrow()
    })

    await vi.advanceTimersByTimeAsync(11_001)

    await Promise.all(requests)
    expect(runtime.closed).toBe(true)
    await expect(backend.exists('/workspace/a')).rejects.toBeInstanceOf(
      WorkerChannelLostError,
    )
    backend.dispose()
  })

  it('resets the timeout streak when the Worker answers', async () => {
    vi.useFakeTimers()
    const runtime = new FakeRuntime()
    const backend = new WorkerExecutionBackend(
      'ssh:test',
      runtime,
      'posix',
      '/workspace',
    )
    for (let round = 0; round < 2; round++) {
      const timedOut = [1, 2].map(n =>
        expect(
          backend.exec(`slow-${round}-${n}`, {
            cwd: '/workspace',
            timeoutMs: 1_000,
          }),
        ).rejects.toThrow('timed out'),
      )
      await vi.advanceTimersByTimeAsync(11_001)
      await Promise.all(timedOut)
      const answered = backend.exists('/workspace/ok')
      const request = runtime.messages.at(-1)
      if (request?.type !== 'fs_op') throw new Error('request missing')
      runtime.emit({
        type: 'fs_op_result',
        requestId: request.requestId,
        ok: true,
        data: true,
      })
      await expect(answered).resolves.toBe(true)
    }
    expect(runtime.closed).toBe(false)
    backend.dispose()
  })
})
