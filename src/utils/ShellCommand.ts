/**
 * In-process background shell — lean stand-in used when ExecutionBackend /
 * Worker is absent (tests, scripts).
 *
 * Output uses file-fd mode: stdout+stderr → task `.output` file.
 */
import type { ChildProcess } from 'child_process'
import { forceKillChild } from './platform.js'
import {
  prepareShellSpawn,
  openShellOutputFdSync,
  closeShellOutputFdSync,
  spawnPreparedShell,
  cleanupCwdFile,
  type ShellKind,
} from './shell/spawn-shell.js'
import { getTaskOutputPath, initTaskOutput } from './task/diskOutput.js'

type InProcessBg = {
  taskId: string
  child: ChildProcess
  done: boolean
  exitCode: number | null
  killed: boolean
  result: Promise<{ code: number | null; interrupted: boolean }>
}

const byTaskId = new Map<string, InProcessBg>()

process.on('exit', () => {
  for (const p of byTaskId.values()) {
    if (!p.done) {
      try {
        forceKillChild(p.child)
      } catch {
        /* ignore */
      }
    }
  }
})

export function killInProcessBackground(taskId: string): void {
  const p = byTaskId.get(taskId)
  if (!p || p.done) return
  p.killed = true
  forceKillChild(p.child)
}

export function spawnInProcessBackground(opts: {
  taskId: string
  command: string
  cwd: string
  shell: ShellKind
}): InProcessBg {
  initTaskOutput(opts.taskId)
  const outputPath = getTaskOutputPath(opts.taskId)
  const prepared = prepareShellSpawn({
    shell: opts.shell,
    userCommand: opts.command,
    cwdFilePrefix: 'agent-bg-cwd',
  })

  const outputFd = openShellOutputFdSync(outputPath)
  let child: ChildProcess
  try {
    child = spawnPreparedShell({
      prepared,
      cwd: opts.cwd,
      outputFd,
    })
  } catch (err) {
    closeShellOutputFdSync(outputFd)
    cleanupCwdFile(prepared.cwdFileNative)
    throw err
  }
  // Parent closes its copy — child has a dup.
  closeShellOutputFdSync(outputFd)
  child.stdin?.end()

  const entry: InProcessBg = {
    taskId: opts.taskId,
    child,
    done: false,
    exitCode: null,
    killed: false,
    result: Promise.resolve({ code: null, interrupted: false }),
  }

  entry.result = new Promise(resolve => {
    child.on('close', code => {
      entry.done = true
      entry.exitCode = code
      cleanupCwdFile(prepared.cwdFileNative)
      resolve({
        code,
        interrupted: entry.killed,
      })
      setTimeout(() => byTaskId.delete(opts.taskId), 60_000).unref?.()
    })
    child.on('error', () => {
      entry.done = true
      entry.exitCode = 1
      cleanupCwdFile(prepared.cwdFileNative)
      resolve({ code: 1, interrupted: entry.killed })
    })
  })

  byTaskId.set(opts.taskId, entry)
  return entry
}

export function pollInProcessBackground(taskId: string): {
  done: boolean
  exitCode: number | null
  killed?: boolean
} | null {
  const p = byTaskId.get(taskId)
  if (!p) return null
  return { done: p.done, exitCode: p.exitCode, killed: p.killed }
}
