/**
 * Agent Worker — FS/shell/LSP for Control Plane via stdio NDJSON.
 *
 * Run: node dist/worker/{slug}-worker.cjs --stdio
 *   or: npx tsx src/worker/main.ts --stdio
 */
import * as fs from 'fs'
import * as path from 'path'
import { createInterface } from 'readline'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
  WorkerFsOp,
} from '../execution/runtime-protocol.js'
import {
  configureLspHost,
  runLspOp,
  setLspEventSender,
  shutdownLspHost,
} from './lsp-host.js'
import type { LspServerConfig } from '../core/types.js'
import { runShellCommand, type ShellKind } from '../core/shell/spawn-shell.js'
import {
  prepareShellSpawn,
  openShellOutputHandle,
  closeShellOutputHandle,
  spawnPreparedShell,
  cleanupCwdFile,
} from '../core/shell/spawn-shell.js'
import { forceKillChild } from '../core/platform.js'
import { type ChildProcess } from 'child_process'
import { runRg } from './run-rg.js'
import {
  APP_SLUG,
  WORKER_BG_CWD_FILE_PREFIX,
  WORKER_CWD_FILE_PREFIX,
} from '../brand.js'

const WORKER_VERSION =
  process.env.WORKER_VERSION ?? process.env.npm_package_version ?? '1.0.0'

let boundCwd: string | null = null
let boundEnvId = 'local'
let shuttingDown = false

type BgEntry = {
  taskId: string
  child: ChildProcess
  done: boolean
  exitCode: number | null
  killed: boolean
}

type ForegroundEntry = {
  controller: AbortController
  child?: ChildProcess
}

const bgByTask = new Map<string, BgEntry>()
const foregroundByRequest = new Map<string, ForegroundEntry>()

function killTrackedProcessGroups(): void {
  // Exit handlers cannot await timers. Kill every foreground process group
  // synchronously before this Worker disappears.
  for (const entry of foregroundByRequest.values()) {
    if (!entry.child) continue
    try {
      forceKillChild(entry.child)
    } catch {
      /* ignore */
    }
  }
  for (const e of bgByTask.values()) {
    if (!e.done) {
      try {
        forceKillChild(e.child)
      } catch {
        /* ignore */
      }
    }
  }
}

process.on('exit', killTrackedProcessGroups)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    killTrackedProcessGroups()
    process.exit(signal === 'SIGTERM' ? 143 : 130)
  })
}

function send(msg: RuntimeServerMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

setLspEventSender(send)

function logErr(msg: string): void {
  process.stderr.write(`[${APP_SLUG}-worker] ${msg}\n`)
}

async function runFsOp(op: WorkerFsOp, requestId: string): Promise<unknown> {
  switch (op.op) {
    case 'readText':
      return fs.promises.readFile(op.path, 'utf-8')
    case 'writeText': {
      await fs.promises.mkdir(path.dirname(op.path), { recursive: true })
      await fs.promises.writeFile(op.path, op.content, 'utf-8')
      return null
    }
    case 'mkdirp': {
      await fs.promises.mkdir(op.path, { recursive: true })
      return null
    }
    case 'exists': {
      try {
        await fs.promises.access(op.path)
        return true
      } catch {
        return false
      }
    }
    case 'isDirectory': {
      try {
        return (await fs.promises.stat(op.path)).isDirectory()
      } catch {
        return false
      }
    }
    case 'exec': {
      const shell = (op.shell ?? 'bash') as ShellKind
      logErr(
        `exec shell=${shell} cwd=${op.cwd} cmd=${JSON.stringify(op.command.slice(0, 120))}`,
      )
      const entry: ForegroundEntry = {
        controller: new AbortController(),
      }
      foregroundByRequest.set(requestId, entry)
      try {
        return await runShellCommand({
          shell,
          command: op.command,
          cwd: op.cwd,
          timeoutMs: op.timeoutMs ?? 120_000,
          abortSignal: entry.controller.signal,
          onSpawn: child => {
            entry.child = child
          },
          cwdFilePrefix: WORKER_CWD_FILE_PREFIX,
        })
      } finally {
        foregroundByRequest.delete(requestId)
      }
    }
    case 'exec_cancel': {
      const entry = foregroundByRequest.get(op.targetRequestId)
      entry?.controller.abort('control-plane-cancel')
      return { acknowledged: true, found: entry != null }
    }
    case 'exec_bg_start': {
      await fs.promises.mkdir(path.dirname(op.outputPath), { recursive: true })
      // Truncate/create; openShellOutputHandle uses 'w' on Windows (MSYS-safe).
      const prepared = prepareShellSpawn({
        shell: (op.shell ?? 'bash') as ShellKind,
        userCommand: op.command,
        cwdFilePrefix: WORKER_BG_CWD_FILE_PREFIX,
      })
      const outputHandle = await openShellOutputHandle(op.outputPath)
      let child: ChildProcess
      try {
        child = spawnPreparedShell({
          prepared,
          cwd: op.cwd,
          outputFd: outputHandle.fd,
        })
      } catch (err) {
        await closeShellOutputHandle(outputHandle)
        cleanupCwdFile(prepared.cwdFileNative)
        throw err
      }
      // Parent closes its copy — child has a dup.
      await closeShellOutputHandle(outputHandle)
      child.stdin?.end()

      const entry: BgEntry = {
        taskId: op.taskId,
        child,
        done: false,
        exitCode: null,
        killed: false,
      }
      child.on('close', code => {
        entry.done = true
        entry.exitCode = code
        cleanupCwdFile(prepared.cwdFileNative)
      })
      child.on('error', () => {
        entry.done = true
        entry.exitCode = 1
        cleanupCwdFile(prepared.cwdFileNative)
      })
      bgByTask.set(op.taskId, entry)
      const pid = child.pid
      if (pid == null) {
        cleanupCwdFile(prepared.cwdFileNative)
        throw new Error('Failed to spawn background process')
      }
      return { pid }
    }
    case 'exec_bg_poll': {
      const e = bgByTask.get(op.taskId)
      if (!e) {
        return { done: true, exitCode: null, killed: false }
      }
      return {
        done: e.done,
        exitCode: e.exitCode,
        killed: e.killed,
      }
    }
    case 'exec_bg_kill': {
      const e = bgByTask.get(op.taskId)
      if (e && !e.done) {
        e.killed = true
        forceKillChild(e.child)
      }
      return { ok: true }
    }
    case 'rg':
      return runRg({
        args: op.args,
        target: op.target,
        timeoutMs: op.timeoutMs,
      })
    default: {
      const _exhaustive: never = op
      throw new Error(`Unknown op: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

async function handle(msg: RuntimeClientMessage): Promise<void> {
  switch (msg.type) {
    case 'bind': {
      boundEnvId = msg.workspace.environmentId
      try {
        boundCwd = await fs.promises.realpath(msg.workspace.cwd)
      } catch {
        boundCwd = path.resolve(msg.workspace.cwd)
      }
      try {
        process.chdir(boundCwd)
      } catch (err) {
        send({
          type: 'error',
          message: `Cannot chdir to ${boundCwd}: ${err instanceof Error ? err.message : err}`,
        })
        return
      }
      if (msg.lspServers) {
        configureLspHost(
          boundCwd,
          msg.lspServers as Record<string, LspServerConfig>,
        )
        logErr(
          `lsp configured: ${Object.keys(msg.lspServers).join(', ') || '(none)'}`,
        )
      }
      send({
        type: 'ready',
        workspace: { environmentId: boundEnvId, cwd: boundCwd },
        workerVersion: WORKER_VERSION,
      })
      return
    }
    case 'fs_op': {
      try {
        const data = await runFsOp(msg.op, msg.requestId)
        send({ type: 'fs_op_result', requestId: msg.requestId, ok: true, data })
      } catch (err) {
        send({
          type: 'fs_op_result',
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'lsp_op': {
      try {
        const data = await runLspOp(msg.op)
        send({
          type: 'lsp_op_result',
          requestId: msg.requestId,
          ok: true,
          data,
        })
      } catch (err) {
        send({
          type: 'lsp_op_result',
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'ping':
      send({ type: 'pong', id: msg.id })
      return
    case 'shutdown':
      shuttingDown = true
      await shutdownLspHost().catch(() => {})
      process.exit(0)
      return
    case 'interrupt':
      logErr(`interrupt ${msg.runId} (no-op in worker v1)`)
      return
    case 'control_response':
      return
    default:
      send({
        type: 'error',
        message: `Unknown message: ${(msg as { type: string }).type}`,
      })
  }
}

export function runWorkerStdio(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', line => {
    if (shuttingDown) return
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: RuntimeClientMessage
    try {
      msg = JSON.parse(trimmed) as RuntimeClientMessage
    } catch {
      send({ type: 'error', message: `Invalid JSON: ${trimmed.slice(0, 120)}` })
      return
    }
    void handle(msg)
  })
  rl.on('close', () => {
    if (!shuttingDown) process.exit(0)
  })

  logErr(
    `started version=${WORKER_VERSION} pid=${process.pid} agentRoot=${process.env.AGENT_ROOT || '(default)'}`,
  )
}
