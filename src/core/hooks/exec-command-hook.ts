import { spawn } from 'child_process'

export type CommandHookResult = {
  stdout: string
  stderr: string
  /** Exit code; null when the process was killed or never started. */
  status: number | null
  timedOut: boolean
  aborted: boolean
  /** Set when the command could not be started. */
  spawnError?: string
}

export type ExecCommandHook = (
  command: string,
  jsonInput: string,
  options: {
    cwd: string
    timeoutMs: number
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
  },
) => Promise<CommandHookResult>

const MAX_OUTPUT_CHARS = 1_000_000
const KILL_GRACE_MS = 500
const isWindows = process.platform === 'win32'

/** Runs one hook command in a shell, with the event JSON on stdin. */
export const execCommandHook: ExecCommandHook = (
  command,
  jsonInput,
  { cwd, timeoutMs, env, signal },
) =>
  new Promise(resolve => {
    if (signal?.aborted) {
      resolve({
        stdout: '',
        stderr: '',
        status: null,
        timedOut: false,
        aborted: true,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so a kill reaches what the shell started.
      detached: !isWindows,
    })

    const finish = (status: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout,
        stderr,
        status,
        timedOut,
        aborted,
        ...(spawnError ? { spawnError } : {}),
      })
    }
    const kill = () => {
      try {
        if (!isWindows && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        // already gone
      }
      // Do not wait on a process that ignores the signal or left a
      // grandchild holding the output pipes open.
      setTimeout(() => finish(null), KILL_GRACE_MS).unref()
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk
    })
    child.on('error', err => finish(null, err.message))
    child.on('close', code => finish(code))

    // A hook that does not read stdin closes it early; that is not an error.
    child.stdin?.on('error', () => {})
    child.stdin?.end(jsonInput)
  })
