import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindStdioRuntime, StdioRuntimePort } from './stdio-runtime-port.js'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
} from './runtime-protocol.js'
import { WorkerExecutionBackend } from './worker-execution-backend.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('real Worker stdout framing', () => {
  let dir: string
  let child: ChildProcess
  let port: StdioRuntimePort

  afterEach(async () => {
    await port?.close().catch(() => {})
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL')
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the channel alive when shared modules log with console.log', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-stdout-'))
    child = spawn(
      path.resolve('node_modules/.bin/tsx'),
      ['src/worker/entry.ts', '--stdio'],
      { cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    if (!child.stdin || !child.stdout) {
      throw new Error('Worker stdio was not created')
    }
    const workspace = { environmentId: 'local', cwd: dir }
    port = new StdioRuntimePort({
      workspace,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr ?? undefined,
      child,
    })
    await bindStdioRuntime(port, workspace, 10_000)

    const errors: string[] = []
    port.onMessage(msg => {
      if (msg.type === 'error') errors.push(msg.message)
    })
    const request = (
      msg: RuntimeClientMessage & { requestId: string },
    ): Promise<RuntimeServerMessage> =>
      new Promise(resolve => {
        const off = port.onMessage(reply => {
          const mine = 'requestId' in reply && reply.requestId === msg.requestId
          if (mine || reply.type === 'error') {
            off()
            resolve(reply)
          }
        })
        port.send(msg)
      })

    await request({
      type: 'lsp_op',
      requestId: 'configure',
      op: {
        op: 'configure',
        servers: {
          fake: {
            command: 'omni-missing-lsp',
            extensionToLanguage: { '.zzz': 'zzz' },
          },
        },
      },
    })
    // No server handles .txt: the LSP manager logs an "open skip" line.
    await expect(
      request({
        type: 'lsp_op',
        requestId: 'open',
        op: {
          op: 'openFile',
          filePath: path.join(dir, 'notes.txt'),
          content: 'x',
        },
      }),
    ).resolves.toMatchObject({ type: 'lsp_op_result', ok: true })

    await expect(port.health()).resolves.toBe('ok')
    expect(errors).toEqual([])
  }, 20_000)

  it('round-trips multi-MB binary files through readBytes', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-bytes-'))
    child = spawn(
      path.resolve('node_modules/.bin/tsx'),
      ['src/worker/entry.ts', '--stdio'],
      { cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    if (!child.stdin || !child.stdout) {
      throw new Error('Worker stdio was not created')
    }
    const workspace = { environmentId: 'local', cwd: dir }
    port = new StdioRuntimePort({
      workspace,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr ?? undefined,
      child,
    })
    await bindStdioRuntime(port, workspace, 10_000)
    const backend = new WorkerExecutionBackend('local', port, 'local', dir)

    const bytes = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff
    const file = path.join(dir, 'chart.png')
    fs.writeFileSync(file, bytes)

    const read = await backend.readBytes(file, bytes.length)
    expect(read.equals(bytes)).toBe(true)
    await expect(backend.readBytes(file, bytes.length - 1)).rejects.toThrow(
      /too large/,
    )
    backend.dispose()
  }, 20_000)
})
