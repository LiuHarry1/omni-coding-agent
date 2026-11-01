import { spawn, type ChildProcess } from 'child_process'

export type DockerResult = {
  stdout: string
  stderr: string
  code: number | null
}

/** One-shot `docker <args>`; resolves with the exit code instead of throwing. */
export type DockerRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<DockerResult>

/** Long-lived `docker <args>` with piped stdio (Worker channel). */
export type DockerSpawner = (args: string[]) => ChildProcess

export class DockerError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'DockerError'
  }
}

/** `DOCKER_BIN` covers hosts where the CLI is off PATH (Docker Desktop's ~/.docker/bin). */
function dockerBin(): string {
  return process.env.DOCKER_BIN?.trim() || 'docker'
}

export const runDockerCli: DockerRunner = (args, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 60_000
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8')
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new DockerError(
          `docker ${args[0]} timed out after ${timeoutMs}ms`,
          null,
          text(err),
        ),
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

export const spawnDockerCli: DockerSpawner = args =>
  spawn(dockerBin(), args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

export async function dockerOk(
  run: DockerRunner,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<string> {
  const { stdout, stderr, code } = await run(args, opts)
  if (code !== 0) {
    throw new DockerError(
      stderr.trim() || stdout.trim() || `docker ${args[0]} exited ${code}`,
      code,
      stderr,
    )
  }
  return stdout
}
