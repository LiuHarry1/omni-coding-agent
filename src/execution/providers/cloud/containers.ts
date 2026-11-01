import type { ChildProcess } from 'child_process'
import type { CloudWorkspaceConfig } from './config.js'
import {
  DockerError,
  dockerOk,
  runDockerCli,
  spawnDockerCli,
  type DockerResult,
  type DockerRunner,
  type DockerSpawner,
} from './docker-cli.js'

export const WORKSPACE_LABEL = 'agent.workspace.id'
/** Control plane that owns the object; several may share one Docker host. */
export const INSTANCE_LABEL = 'agent.workspace.instance'

const WORKSPACE_ID_RE = /^[a-z0-9]{8,32}$/

export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id)
}

function assertWorkspaceId(id: string): void {
  // Ids become docker object names and argv; never let anything else through.
  if (!isValidWorkspaceId(id)) {
    throw new Error(`Invalid workspace id: ${JSON.stringify(id)}`)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isNoSuchObject(err: unknown): boolean {
  return (
    err instanceof DockerError &&
    /no such (container|volume|object)/i.test(err.message)
  )
}

export type ContainerState = 'running' | 'stopped' | 'missing'

export type WorkspaceExecOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * Docker objects behind cloud workspaces. The container is disposable; only
 * the volume mounted at `volumeMount` persists. Every argument passed to
 * `docker run` comes from config, never from a user or a repository.
 */
export class WorkspaceContainers {
  private starting = new Map<string, Promise<void>>()
  private network: Promise<void> | null = null
  private tombstones = new Set<string>()

  constructor(
    readonly config: CloudWorkspaceConfig,
    private run: DockerRunner = runDockerCli,
    private spawner: DockerSpawner = spawnDockerCli,
  ) {}

  /** Fail startup early when the explicitly enabled Cloud backend is unusable. */
  async preflight(): Promise<void> {
    try {
      await dockerOk(this.run, ['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 10_000,
      })
    } catch (err) {
      throw new Error(
        `Cloud Workspace Docker daemon is unavailable: ${errorMessage(err)}`,
        { cause: err },
      )
    }

    try {
      await dockerOk(this.run, ['image', 'inspect', this.config.image], {
        timeoutMs: 10_000,
      })
    } catch (err) {
      throw new Error(
        `Cloud Workspace image "${this.config.image}" is unavailable: ${errorMessage(err)}. Build it with "npm run build:cloud".`,
        { cause: err },
      )
    }
  }

  containerName(id: string): string {
    assertWorkspaceId(id)
    return `${this.config.namePrefix}${id}`
  }

  volumeName(id: string): string {
    assertWorkspaceId(id)
    return `${this.config.namePrefix}${id}`
  }

  /** Permanently prevent this process from recreating a deleted workspace. */
  tombstone(id: string): void {
    assertWorkspaceId(id)
    this.tombstones.add(id)
  }

  private assertAvailable(id: string): void {
    assertWorkspaceId(id)
    if (this.tombstones.has(id)) {
      throw new Error(`Cloud workspace was deleted: ${id}`)
    }
  }

  runArgs(id: string): string[] {
    const c = this.config
    return [
      'run',
      '--detach',
      '--name',
      this.containerName(id),
      '--hostname',
      'workspace',
      '--label',
      `${WORKSPACE_LABEL}=${id}`,
      '--label',
      `${INSTANCE_LABEL}=${c.instance}`,
      '--user',
      c.user,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      c.memory,
      '--cpus',
      c.cpus,
      '--pids-limit',
      String(c.pidsLimit),
      '--network',
      c.network,
      '--mount',
      `type=volume,src=${this.volumeName(id)},dst=${c.volumeMount}`,
      '--restart',
      'no',
      '--init',
      c.image,
      'sleep',
      'infinity',
    ]
  }

  async state(id: string): Promise<ContainerState> {
    const { stdout, stderr, code } = await this.run([
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      this.containerName(id),
    ])
    if (code !== 0) {
      if (/no such (container|object)/i.test(stderr || stdout)) {
        return 'missing'
      }
      throw new DockerError(
        stderr.trim() || `docker inspect exited ${code}`,
        code,
        stderr,
      )
    }
    return stdout.trim() === 'true' ? 'running' : 'stopped'
  }

  async ensureVolume(id: string): Promise<void> {
    this.assertAvailable(id)
    await dockerOk(this.run, [
      'volume',
      'create',
      '--label',
      `${WORKSPACE_LABEL}=${id}`,
      '--label',
      `${INSTANCE_LABEL}=${this.config.instance}`,
      this.volumeName(id),
    ])
  }

  /** Start a container for `id`, recreating a stopped one from the current image. */
  async ensureRunning(id: string): Promise<void> {
    this.assertAvailable(id)
    const pending = this.starting.get(id)
    if (pending) {
      await pending
      this.assertAvailable(id)
      return
    }
    const started = this.startIfNeeded(id)
      .catch(async error => {
        if (this.tombstones.has(id)) {
          await this.removeContainer(id).catch(() => {})
          await this.removeVolume(id).catch(() => {})
        }
        throw error
      })
      .finally(() => {
        this.starting.delete(id)
      })
    this.starting.set(id, started)
    await started
    this.assertAvailable(id)
  }

  private async startIfNeeded(id: string): Promise<void> {
    this.assertAvailable(id)
    const current = await this.state(id)
    this.assertAvailable(id)
    if (current === 'running') return
    if (current === 'stopped') await this.removeContainer(id)
    await this.ensureNetwork()
    this.assertAvailable(id)
    await this.ensureVolume(id)
    this.assertAvailable(id)
    await dockerOk(this.run, this.runArgs(id), { timeoutMs: 120_000 })
    this.assertAvailable(id)
  }

  /**
   * Create the workspace bridge once. Inter-container traffic is disabled so
   * workspaces cannot reach each other; the control plane never joins it.
   */
  ensureNetwork(): Promise<void> {
    if (!this.network) {
      this.network = (async () => {
        const name = this.config.network
        const inspect = await this.run(['network', 'inspect', name])
        if (inspect.code === 0) return
        await dockerOk(this.run, [
          'network',
          'create',
          '--driver',
          'bridge',
          '--opt',
          'com.docker.network.bridge.enable_icc=false',
          '--label',
          `${WORKSPACE_LABEL}=network`,
          name,
        ])
      })().catch(err => {
        this.network = null
        throw err
      })
    }
    return this.network
  }

  execArgs(
    id: string,
    argv: string[],
    opts: WorkspaceExecOptions & { interactive?: boolean } = {},
  ): string[] {
    const args = ['exec']
    if (opts.interactive) args.push('--interactive')
    args.push('--user', this.config.user)
    args.push('--env', `HOME=${this.config.homeDir}`)
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push('--env', `${key}=${value}`)
    }
    if (opts.cwd) args.push('--workdir', opts.cwd)
    args.push(this.containerName(id), ...argv)
    return args
  }

  exec(
    id: string,
    argv: string[],
    opts: WorkspaceExecOptions = {},
  ): Promise<DockerResult> {
    this.assertAvailable(id)
    return this.run(this.execArgs(id, argv, opts), {
      timeoutMs: opts.timeoutMs,
    })
  }

  async execOk(
    id: string,
    argv: string[],
    opts: WorkspaceExecOptions = {},
  ): Promise<string> {
    this.assertAvailable(id)
    return dockerOk(this.run, this.execArgs(id, argv, opts), {
      timeoutMs: opts.timeoutMs,
    })
  }

  /** `docker exec -i` with piped stdio, for the Worker NDJSON channel. */
  spawnExec(
    id: string,
    argv: string[],
    opts: Omit<WorkspaceExecOptions, 'timeoutMs'> = {},
  ): ChildProcess {
    this.assertAvailable(id)
    return this.spawner(this.execArgs(id, argv, { ...opts, interactive: true }))
  }

  async removeContainer(id: string): Promise<void> {
    try {
      await dockerOk(this.run, ['rm', '--force', this.containerName(id)])
    } catch (err) {
      if (!isNoSuchObject(err)) throw err
    }
  }

  async removeVolume(id: string): Promise<void> {
    try {
      await dockerOk(this.run, ['volume', 'rm', '--force', this.volumeName(id)])
    } catch (err) {
      if (!isNoSuchObject(err)) throw err
    }
  }

  /** Workspace ids of running containers owned by this control plane. */
  async listRunning(): Promise<string[]> {
    const out = await dockerOk(this.run, [
      'ps',
      '--filter',
      `label=${WORKSPACE_LABEL}`,
      '--filter',
      `label=${INSTANCE_LABEL}=${this.config.instance}`,
      '--format',
      `{{.Label "${WORKSPACE_LABEL}"}}`,
    ])
    return out
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(isValidWorkspaceId)
  }
}
