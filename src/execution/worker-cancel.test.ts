import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindStdioRuntime, StdioRuntimePort } from './stdio-runtime-port.js'
import { WorkerExecutionBackend } from './worker-execution-backend.js'
import type { RuntimeServerMessage } from './runtime-protocol.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function longLivedChildCommand(
  pidFile: string,
  terminationFile?: string,
): string {
  const script = [
    `const fs=require('node:fs')`,
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid))`,
    terminationFile
      ? `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(
          terminationFile,
        )},'terminated');process.exit(0)})`
      : '',
    `setInterval(()=>{},1000)`,
  ]
    .filter(Boolean)
    .join(';')
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describePosix('real Worker process cancellation', () => {
  let dir: string
  let child: ChildProcess
  let port: StdioRuntimePort
  let backend: WorkerExecutionBackend

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-cancel-'))
    child = spawn(
      path.resolve('node_modules/.bin/tsx'),
      ['src/worker/entry.ts', '--stdio'],
      {
        cwd: path.resolve('.'),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    if (!child.stdin || !child.stdout) {
      throw new Error('Worker stdio was not created')
    }
    port = new StdioRuntimePort({
      workspace: { environmentId: 'local', cwd: dir },
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr ?? undefined,
      child,
    })
    await bindStdioRuntime(port, { environmentId: 'local', cwd: dir }, 10_000)
    backend = new WorkerExecutionBackend('local', port, 'local', dir)
  })

  afterEach(async () => {
    backend?.dispose()
    await port?.close().catch(() => {})
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL')
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('kills a foreground command tree and acknowledges an already-finished target', async () => {
    const pidFile = path.join(dir, 'foreground.pid')
    const terminated = path.join(dir, 'foreground.terminated')
    const controller = new AbortController()
    const execution = backend.exec(longLivedChildCommand(pidFile, terminated), {
      cwd: dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    await waitFor(
      () => fs.existsSync(pidFile),
      'foreground grandchild did not start',
    )

    controller.abort()
    await expect(execution).resolves.toMatchObject({ interrupted: true })
    await waitFor(
      () => fs.existsSync(terminated),
      'foreground grandchild did not receive SIGTERM',
    )

    const requestId = 'cancel-after-settle'
    const acknowledged = new Promise<RuntimeServerMessage>(resolve => {
      const off = port.onMessage(message => {
        if (
          message.type === 'fs_op_result' &&
          message.requestId === requestId
        ) {
          off()
          resolve(message)
        }
      })
    })
    port.send({
      type: 'fs_op',
      requestId,
      op: { op: 'exec_cancel', targetRequestId: 'already-finished' },
    })
    await expect(acknowledged).resolves.toMatchObject({
      type: 'fs_op_result',
      ok: true,
      data: { acknowledged: true, found: false },
    })
  }, 15_000)

  it('kills the process tree when a foreground command times out', async () => {
    const pidFile = path.join(dir, 'timeout.pid')
    const terminated = path.join(dir, 'timeout.terminated')
    const execution = backend.exec(longLivedChildCommand(pidFile, terminated), {
      cwd: dir,
      timeoutMs: 300,
    })
    await waitFor(() => fs.existsSync(pidFile), 'timeout child did not start')

    await expect(execution).resolves.toMatchObject({
      timedOut: true,
      interrupted: true,
    })
    await waitFor(
      () => fs.existsSync(terminated),
      'timed-out grandchild did not receive SIGTERM',
    )
  }, 15_000)

  it('kills a background task process tree', async () => {
    const pidFile = path.join(dir, 'background.pid')
    await backend.execBgStart({
      taskId: 'background-tree',
      command: longLivedChildCommand(pidFile),
      cwd: dir,
      outputPath: path.join(dir, 'background.output'),
    })
    await waitFor(
      () => fs.existsSync(pidFile),
      'background grandchild did not start',
    )
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(isProcessAlive(pid)).toBe(true)

    await backend.execBgKill('background-tree')
    await waitFor(
      () => !isProcessAlive(pid),
      'background grandchild survived task kill',
    )
  }, 15_000)

  it('kills registered foreground process trees when the Worker exits', async () => {
    const pidFile = path.join(dir, 'worker-exit.pid')
    const execution = backend.exec(longLivedChildCommand(pidFile), {
      cwd: dir,
      timeoutMs: 30_000,
    })
    const rejected = execution.catch(error => error)
    await waitFor(
      () => fs.existsSync(pidFile),
      'worker-exit grandchild did not start',
    )
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))

    child.kill('SIGTERM')
    await rejected
    await waitFor(
      () => !isProcessAlive(pid),
      'foreground grandchild survived Worker exit',
    )
  }, 15_000)
})
