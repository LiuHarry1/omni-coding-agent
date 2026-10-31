import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'

export const isWindows = process.platform === 'win32'

/** One-line platform summary for system prompts. */
export const platformLabel = `${process.platform} (${process.arch})`

function signalPosixProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid
  if (pid == null) return
  try {
    // Shells are spawned detached on POSIX, so their PID is also the process
    // group id. Signalling the group prevents grandchildren becoming orphans.
    process.kill(-pid, signal)
    return
  } catch {
    // PowerShell and test children may not own a process group.
  }
  try {
    child.kill(signal)
  } catch {}
}

export function killChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } catch {}
  } else {
    signalPosixProcessGroup(child, 'SIGTERM')
    const timer = setTimeout(() => forceKillChild(child), 3000)
    timer.unref?.()
  }
}

export function forceKillChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    } catch {}
  } else {
    signalPosixProcessGroup(child, 'SIGKILL')
  }
}

export function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p)
  return isWindows ? resolved.toLowerCase() : resolved
}

export function normalizeGitPath(gitPath: string): string {
  return path.resolve(gitPath)
}
