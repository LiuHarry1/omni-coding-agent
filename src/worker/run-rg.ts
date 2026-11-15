/**
 * Ripgrep on the Worker: execFile argv, exit 0/1 = success.
 * No shell, no `rg || grep` fallthrough.
 */
import { execFile, type ExecFileException } from 'node:child_process'
import { isWindows } from '../utils/platform.js'
import { resolveRgCommand } from '../utils/resolve-rg-command.js'

const MAX_BUFFER_SIZE = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const RG_COMMAND = resolveRgCommand()

function parseLines(stdout: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(Boolean)
}

export type RgResult = { lines: string[] }

export function runRg(opts: {
  args: string[]
  target: string
  timeoutMs?: number
}): Promise<RgResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fullArgs = [...opts.args, opts.target]

  return new Promise((resolve, reject) => {
    execFile(
      RG_COMMAND,
      fullArgs,
      {
        maxBuffer: MAX_BUFFER_SIZE,
        timeout,
        killSignal: isWindows ? undefined : 'SIGKILL',
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (!error) {
          resolve({ lines: parseLines(stdout) })
          return
        }

        // Exit code 1 = no matches (success)
        if (error.code === 1) {
          resolve({ lines: [] })
          return
        }

        if (error.code === 'ENOENT') {
          reject(
            new Error(
              'ripgrep (rg) not found on worker host; install rg (https://github.com/BurntSushi/ripgrep)',
            ),
          )
          return
        }

        const isTimeout =
          error.killed ||
          error.signal === 'SIGTERM' ||
          error.signal === 'SIGKILL' ||
          error.code === 'ABORT_ERR'

        if (isTimeout) {
          reject(
            new Error(
              `ripgrep timed out after ${Math.round(timeout / 1000)}s with no results`,
            ),
          )
          return
        }

        const detail = (stderr || '').trim() || error.message
        reject(new Error(detail || `rg failed with code ${error.code}`))
      },
    )
  })
}
