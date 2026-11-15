/**
 * Ripgrep wrapper around `rg` on PATH.
 *
 * Features:
 *   - Timeout enforced via execFile, with SIGKILL escalation on POSIX
 *     (SIGTERM may not kill rg while it's blocked in uninterruptible
 *     filesystem I/O).
 *   - Single-thread (`-j 1`) retry on EAGAIN errors — these happen in
 *     resource-constrained environments (Docker, CI) when rg can't spawn
 *     its thread pool.
 *   - Distinguishes `exit code 1` (no matches, success) from real
 *     failures, partial-result preservation on timeout/buffer-overflow,
 *     and a dedicated `RipgrepTimeoutError` so callers can tell "search
 *     didn't complete" apart from "no matches".
 *   - When system `rg` is missing (ENOENT) we transparently degrade to
 *     a pure-Node fallback (`./ripgrep-fallback.ts`) that emits line-
 *     format-compatible output. Set `RG_FALLBACK=off` to disable the
 *     fallback and throw `RipgrepNotFoundError` instead; set
 *     `RG_FALLBACK=force` to always use the fallback (useful in CI /
 *     Docker images that don't ship ripgrep).
 */

import type { ChildProcess, ExecFileException } from 'child_process'
import { execFile } from 'child_process'
import { isWindows } from './platform.js'
import { ripGrepFallback } from './ripgrep-fallback.js'
import { resolveRgCommand } from './resolve-rg-command.js'

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

export class RipgrepNotFoundError extends Error {
  constructor() {
    super(
      'ripgrep (`rg`) is not installed or not on PATH. Install it:\n' +
        '  Windows: winget install BurntSushi.ripgrep.MSVC  (or `choco install ripgrep`)\n' +
        '  macOS:   brew install ripgrep\n' +
        '  Linux:   apt install ripgrep / dnf install ripgrep / pacman -S ripgrep',
    )
    this.name = 'RipgrepNotFoundError'
  }
}

/**
 * Cached "is system rg available" flag, set the first time we observe an
 * ENOENT spawning it. Once tripped, subsequent ripGrep calls route
 * straight to the Node fallback without paying the spawn-ENOENT round
 * trip every time.
 *
 * Reset on process restart. Env flags:
 *   - RG_FALLBACK=force  → never try system rg, always use fallback
 *     (useful in CI / Docker images that don't ship ripgrep).
 *   - RG_FALLBACK=off    → never use fallback; throw RipgrepNotFoundError
 *     on ENOENT.
 */
let rgKnownMissing = false
function shouldUseFallback(): boolean {
  if (process.env.RG_FALLBACK === 'force') return true
  if (process.env.RG_FALLBACK === 'off') return false
  return rgKnownMissing
}
function markRgMissing(): void {
  if (!rgKnownMissing) {
    rgKnownMissing = true
    console.warn(
      '[ripgrep] system `rg` not found on PATH — falling back to pure-Node implementation. ' +
        'Install `rg` for much better performance (winget install BurntSushi.ripgrep.MSVC / brew install ripgrep / apt install ripgrep). ' +
        'Set RG_FALLBACK=off to disable the fallback.',
    )
  }
}

// Packaged Electron injects an absolute path under its trusted resources
// directory. Otherwise use the bare command name instead of resolving through
// `which`, which could accidentally trust an executable from the workspace.
const RG_COMMAND = resolveRgCommand()

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): ChildProcess {
  // NB: When running interactively, ripgrep does not require a path as its
  // last argument, but when run non-interactively, it will hang unless a
  // path or file pattern is provided.
  const threadArgs = singleThread ? ['-j', '1'] : []
  const fullArgs = [...threadArgs, ...args, target]

  const timeout =
    parseInt(process.env.RG_TIMEOUT_SECONDS || '', 10) > 0
      ? parseInt(process.env.RG_TIMEOUT_SECONDS!, 10) * 1000
      : 20_000

  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O. On Windows,
  // SIGKILL throws; use default (undefined) which sends SIGTERM.
  return execFile(
    RG_COMMAND,
    fullArgs,
    {
      maxBuffer: MAX_BUFFER_SIZE,
      signal: abortSignal,
      timeout,
      killSignal: isWindows ? undefined : 'SIGKILL',
      windowsHide: true,
    },
    callback,
  )
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  // Fast path: we've already learned that system rg is missing (or the
  // user forced fallback via env). Skip the spawn and run pure-Node.
  if (shouldUseFallback()) {
    return ripGrepFallback(args, target)
  }

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // ENOENT here means `rg` itself wasn't found. Mark it missing,
      // print a one-time warning, and route this call (and all future
      // ones) to the pure-Node fallback. If RG_FALLBACK=off, throw
      // RipgrepNotFoundError with an install hint instead.
      if (error.code === 'ENOENT') {
        if (process.env.RG_FALLBACK === 'off') {
          reject(new RipgrepNotFoundError())
          return
        }
        markRgMissing()
        ripGrepFallback(args, target).then(resolve, reject)
        return
      }

      // Critical errors that indicate ripgrep is broken, not "no matches".
      // These should be surfaced to the user rather than silently
      // returning empty results.
      const CRITICAL_ERROR_CODES = ['EACCES', 'EPERM']
      if (CRITICAL_ERROR_CODES.includes(error.code as string)) {
        reject(error)
        return
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-
      // threaded mode. We only use -j 1 for this specific retry, not for
      // future calls. Persisting single-threaded mode globally would cause
      // timeouts on large repos where EAGAIN is just a transient startup
      // error.
      if (!isRetry && isEagainError(stderr)) {
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true)
          },
          true,
        )
        return
      }

      // For all other errors, try to return partial results if available.
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

      let lines: string[] = []
      if (hasOutput) {
        lines = stdout
          .trim()
          .split('\n')
          .map(line => line.replace(/\r$/, ''))
          .filter(Boolean)
        // Drop last line for timeouts and buffer overflow — it may be
        // incomplete.
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }
      }

      // If we timed out with no results, throw so the model knows the
      // search didn't complete (rather than thinking there were no
      // matches).
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `ripgrep timed out after ${Math.round(parseInt(process.env.RG_TIMEOUT_SECONDS || '20', 10) || 20)}s with no results`,
            lines,
          ),
        )
        return
      }

      // Otherwise, return whatever partial output we have. The agent can
      // decide whether to narrow the search.
      resolve(lines)
    }

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      handleResult(error, stdout, stderr, false)
    })
  })
}
