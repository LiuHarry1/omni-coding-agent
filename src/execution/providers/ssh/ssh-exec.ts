import { spawn, type ChildProcess } from 'child_process'
import { shQuote } from '../../shell-fs.js'
import { buildSshArgs, type ParsedSshHost } from './ssh-config.js'

export class SshExecError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'SshExecError'
  }
}

/**
 * Run a remote command via system `ssh` CLI (BatchMode).
 */
export function sshExec(
  host: ParsedSshHost,
  remoteCommand: string,
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const args = buildSshArgs(host)
  args.push(remoteCommand)

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8')
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new SshExecError(`SSH timed out after ${timeoutMs}ms`, null, text(err)),
      )
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ stdout: text(out), stderr: text(err), code })
    })
  })
}

export async function sshExecOk(
  host: ParsedSshHost,
  remoteCommand: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const { stdout, stderr, code } = await sshExec(host, remoteCommand, opts)
  if (code !== 0) {
    throw new SshExecError(
      stderr.trim() || stdout.trim() || `ssh exited ${code}`,
      code,
      stderr,
    )
  }
  return stdout
}

/**
 * Start a POSIX script on the remote with piped stdio. Wrapped in `sh -c` so
 * a non-POSIX login shell (fish, nu, …) never parses it.
 */
export function sshSpawn(host: ParsedSshHost, script: string): ChildProcess {
  const args = buildSshArgs(host)
  args.push(`sh -c ${shQuote(script)}`)
  return spawn('ssh', args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Probe connectivity with a trivial remote command. */
export async function sshProbe(host: ParsedSshHost): Promise<void> {
  await sshExecOk(host, 'echo ok', { timeoutMs: 20_000 })
}

export { shQuote }
