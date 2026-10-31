/**
 * Shared shell spawn.
 * Worker `exec` and in-process shell-runner both call this — one wrap/args/cwd story.
 *
 * Default output capture is **file fd** (tool mode): stdout+stderr → one file;
 * Windows opens with `'w'` so Git Bash/MSYS does not silently discard output.
 * Pass `usePipeMode: true` for real-time stream callbacks (hooks path).
 */
import { spawn, type ChildProcess, type StdioOptions } from 'child_process'
import * as fs from 'fs'
import { open as fsOpen, type FileHandle } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  posixPathToWindowsPath,
  resolveBashExecutable,
  resolvePowerShellExecutable,
  windowsPathToPosixPath,
} from './windows-paths.js'
import { forceKillChild, killChild } from '../platform.js'
import { getShellHome } from '../../utils/request-scope.js'
import { WORKER_CWD_FILE_PREFIX } from '../../brand.js'
import {
  quotePosixPath,
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../../utils/bash/shellQuoting.js'

const isWindows = process.platform === 'win32'

/** Default cap for returned stdout (file or pipe). */
export const DEFAULT_SHELL_OUTPUT_CAP = 100_000

/** Shell used by Bash / PowerShell tools and Worker `fs_op.exec`. */
export type ShellKind = 'bash' | 'powershell'

export type PreparedShellSpawn = {
  shellKind: ShellKind
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Native path for Node readFileSync / unlinkSync. */
  cwdFileNative: string
}

export type ShellExecResult = {
  stdout: string
  stderr: string
  code: number | null
  cwdAfter?: string
  child: ChildProcess
}

export type RunShellCommandResult = {
  stdout: string
  stderr: string
  code: number | null
  cwdAfter?: string
  timedOut?: boolean
  interrupted?: boolean
}

function makeTempPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
}

/**
 * Rewrite `>nul`, quote for eval, optional `< /dev/null`, then write cwd with
 * `pwd -P` — on Git Bash `pwd -P` is an MSYS path like `/tmp/...`, which is
 * not `process.cwd()`, so prefer `pwd -W` when it exists (the same native
 * path `readCwdAfter`'s `realpathSync` expects).
 */
function wrapBash(
  userCmd: string,
  cwdFileForBash: string,
  hasStdin = false,
): string {
  const normalized = rewriteWindowsNullRedirect(userCmd)
  // `< /dev/null` stops interactive commands from hanging on a tty, but it
  // must not be added when the caller is feeding stdin — it would shadow it.
  const quoted = quoteShellCommand(
    normalized,
    !hasStdin && shouldAddStdinRedirect(normalized),
  )
  const pwd = isWindows ? '{ pwd -W 2>/dev/null || pwd -P; }' : 'pwd -P'
  return `eval ${quoted} && ${pwd} >| ${quotePosixPath(cwdFileForBash)}`
}

function wrapPowerShell(userCmd: string, cwdFileNative: string): string {
  const escaped = cwdFileNative.replace(/'/g, "''")
  return [
    userCmd,
    `$_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }`,
    `(Get-Location).Path | Out-File -FilePath '${escaped}' -Encoding utf8 -NoNewline`,
    `exit $_ec`,
  ].join('\n')
}

/** Build spawn argv/env; bash on Windows uses POSIX cwd-file path in the trailer. */
export function prepareShellSpawn(opts: {
  shell: ShellKind
  userCommand: string
  cwdFilePrefix?: string
  /** True when the caller will write to the child's stdin. */
  hasStdin?: boolean
}): PreparedShellSpawn {
  const cwdFileNative = makeTempPath(opts.cwdFilePrefix ?? 'agent-shell-cwd')

  const agentHome = getShellHome()
  const homeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: agentHome,
    ...(isWindows ? { USERPROFILE: agentHome } : {}),
  }

  if (opts.shell === 'powershell') {
    return {
      shellKind: 'powershell',
      command: resolvePowerShellExecutable(),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        wrapPowerShell(opts.userCommand, cwdFileNative),
      ],
      env: homeEnv,
      cwdFileNative,
    }
  }

  const cwdFileForBash = isWindows
    ? windowsPathToPosixPath(cwdFileNative)
    : cwdFileNative
  return {
    shellKind: 'bash',
    command: resolveBashExecutable(),
    args: isWindows
      ? ['-c', wrapBash(opts.userCommand, cwdFileForBash, opts.hasStdin)]
      : ['-lc', wrapBash(opts.userCommand, cwdFileForBash, opts.hasStdin)],
    env: { ...homeEnv, TERM: 'dumb' },
    cwdFileNative,
  }
}

/**
 * Read cwd trailer. Windows bash: POSIX → native (`posixPathToWindowsPath`),
 * then `realpathSync` so a mangled MSYS path that is not a real directory
 * does not replace the session cwd.
 */
export function readCwdAfter(
  cwdFileNative: string,
  shellKind: ShellKind,
): string | undefined {
  try {
    const tracked = fs.readFileSync(cwdFileNative, 'utf8').trim()
    if (!tracked) return undefined
    const native =
      shellKind === 'bash' && isWindows
        ? posixPathToWindowsPath(tracked)
        : tracked
    try {
      return fs.realpathSync(native)
    } catch {
      return undefined
    }
  } catch {
    return undefined
  }
}

export function cleanupCwdFile(cwdFileNative: string): void {
  try {
    fs.unlinkSync(cwdFileNative)
  } catch {
    // ignore
  }
}

/**
 * Open an output file for shell stdout+stderr (file mode).
 * Windows: `'w'` — MSYS needs FILE_WRITE_DATA or it silently discards output.
 * POSIX: O_APPEND so interleaved stdout/stderr writes stay atomic.
 */
export async function openShellOutputHandle(
  outputPath: string,
): Promise<FileHandle> {
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
  return fsOpen(
    outputPath,
    isWindows
      ? 'w'
      : fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          O_NOFOLLOW,
  )
}

/** Sync open for background spawn APIs that must return immediately. */
export function openShellOutputFdSync(outputPath: string): number {
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
  return fs.openSync(
    outputPath,
    isWindows
      ? 'w'
      : fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          O_NOFOLLOW,
  )
}

export function closeShellOutputFdSync(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    // ignore
  }
}

/** Close parent FileHandle after spawn; child already has its own dup. */
export async function closeShellOutputHandle(
  handle: FileHandle | undefined,
): Promise<void> {
  if (!handle) return
  try {
    await handle.close()
  } catch {
    // fd may already be closed; safe to ignore
  }
}

function capOutput(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text
  return '...[earlier output truncated]\n' + text.slice(-maxBytes)
}

function readOutputFile(filePath: string, maxBytes: number): string {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length <= maxBytes) return buf.toString('utf8')
    return (
      '...[earlier output truncated]\n' +
      buf.subarray(buf.length - maxBytes).toString('utf8')
    )
  } catch {
    return ''
  }
}

export type SpawnPreparedShellOpts = {
  prepared: PreparedShellSpawn
  cwd: string
  /**
   * When set, stdout+stderr are redirected to this fd (file mode).
   * Caller opens via `openShellOutputHandle` / `openShellOutputFdSync` and
   * must close the **parent** copy after spawn (child has its own dup).
   */
  outputFd?: number
  /** Pipe mode — real-time stream callbacks. Mutually exclusive with outputFd. */
  usePipeMode?: boolean
  detached?: boolean
}

/**
 * Spawn a prepared shell. Prefer passing `outputFd` (file mode).
 * Returns the child; caller owns lifecycle / wait / cwd trailer cleanup.
 */
export function spawnPreparedShell(opts: SpawnPreparedShellOpts): ChildProcess {
  const { prepared, cwd, outputFd, usePipeMode, detached } = opts
  if (outputFd !== undefined && usePipeMode) {
    throw new Error(
      'spawnPreparedShell: pass either outputFd or usePipeMode, not both',
    )
  }

  const stdio: StdioOptions =
    outputFd !== undefined
      ? ['pipe', outputFd, outputFd]
      : ['pipe', 'pipe', 'pipe']

  // Detached bash: new process group, and on Windows a GUI
  // parent (Electron / no console) will not block Git Bash on an inherited tty.
  const useDetached = detached ?? prepared.shellKind === 'bash'

  return spawn(prepared.command, prepared.args, {
    cwd,
    env: prepared.env,
    stdio,
    windowsHide: true,
    detached: useDetached,
  })
}

/**
 * Foreground shell exec for Worker / shell-runner.
 * Default: file-fd capture.
 */
export async function runShellCommand(opts: {
  shell: ShellKind
  command: string
  cwd: string
  timeoutMs: number
  cwdFilePrefix?: string
  stdin?: string
  abortSignal?: AbortSignal
  /** Called synchronously after spawn so the Worker can track process cleanup. */
  onSpawn?: (child: ChildProcess) => void
  /** Default false — file fd mode. True = pipes (real-time onStdout-style). */
  usePipeMode?: boolean
  /** Progress while running (polled from output file, or pipe chunks in pipe mode). */
  onProgress?: (text: string) => void
  progressIntervalMs?: number
  maxOutputBytes?: number
}): Promise<RunShellCommandResult> {
  let prepared: PreparedShellSpawn
  try {
    prepared = prepareShellSpawn({
      shell: opts.shell,
      userCommand: opts.command,
      cwdFilePrefix: opts.cwdFilePrefix ?? WORKER_CWD_FILE_PREFIX,
      hasStdin: opts.stdin != null && opts.stdin.length > 0,
    })
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }

  const usePipe = opts.usePipeMode === true
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_SHELL_OUTPUT_CAP
  const progressMs = opts.progressIntervalMs ?? 2_000
  const outputPath = usePipe ? undefined : makeTempPath('agent-shell-out')

  let outputHandle: FileHandle | undefined
  if (!usePipe && outputPath) {
    outputHandle = await openShellOutputHandle(outputPath)
  }

  let child: ChildProcess
  try {
    child = spawnPreparedShell({
      prepared,
      cwd: opts.cwd,
      outputFd: outputHandle?.fd,
      usePipeMode: usePipe,
    })
  } catch (err) {
    await closeShellOutputHandle(outputHandle)
    if (outputPath) {
      try {
        fs.unlinkSync(outputPath)
      } catch {
        /* ignore */
      }
    }
    cleanupCwdFile(prepared.cwdFileNative)
    throw err
  }
  opts.onSpawn?.(child)

  // Parent closes its copy — child has a dup.
  await closeShellOutputHandle(outputHandle)
  outputHandle = undefined

  if (opts.stdin != null && opts.stdin.length > 0) {
    child.stdin?.write(opts.stdin)
  }
  child.stdin?.end()

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let interrupted = false
  let settled = false

  if (usePipe) {
    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8')
      stdout = capOutput(stdout + chunk, maxBytes)
      opts.onProgress?.(
        stdout + (stderr ? `\n<stderr>\n${stderr}</stderr>` : ''),
      )
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = capOutput(stderr + d.toString('utf8'), maxBytes)
    })
  }

  let progressTimer: ReturnType<typeof setInterval> | undefined
  if (!usePipe && outputPath && opts.onProgress) {
    progressTimer = setInterval(() => {
      opts.onProgress?.(readOutputFile(outputPath, maxBytes))
    }, progressMs)
    progressTimer.unref?.()
  }

  const clearProgress = () => {
    if (progressTimer) clearInterval(progressTimer)
  }

  const result = await new Promise<RunShellCommandResult>((resolve, reject) => {
    const finish = (partial: RunShellCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearProgress()
      opts.abortSignal?.removeEventListener('abort', onAbort)
      const cwdAfter = readCwdAfter(prepared.cwdFileNative, prepared.shellKind)
      cleanupCwdFile(prepared.cwdFileNative)

      let out = partial.stdout
      let err = partial.stderr
      if (!usePipe && outputPath) {
        out = readOutputFile(outputPath, maxBytes)
        err = ''
        try {
          fs.unlinkSync(outputPath)
        } catch {
          /* ignore */
        }
      }

      resolve({
        ...partial,
        stdout: out,
        stderr: err,
        cwdAfter,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
      setTimeout(() => {
        forceKillChild(child)
        // If `close` never fires (rare Windows races), still settle.
        setTimeout(() => {
          finish({
            stdout,
            stderr,
            code: null,
            timedOut: true,
            interrupted: true,
          })
        }, 500)
      }, 3000)
    }, opts.timeoutMs)

    const onAbort = () => {
      interrupted = true
      killChild(child)
    }
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (opts.abortSignal?.aborted) onAbort()

    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearProgress()
      opts.abortSignal?.removeEventListener('abort', onAbort)
      cleanupCwdFile(prepared.cwdFileNative)
      if (outputPath) {
        try {
          fs.unlinkSync(outputPath)
        } catch {
          /* ignore */
        }
      }
      reject(err)
    })

    child.on('close', code => {
      finish({
        stdout,
        stderr,
        code,
        timedOut,
        interrupted: interrupted || timedOut,
      })
    })
  })

  return result
}
