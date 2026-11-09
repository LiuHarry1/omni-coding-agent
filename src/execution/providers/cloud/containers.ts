import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { slugifyEmail } from '../../../server/auth/identity.js'
import { getAppDirName } from '../../../utils/app-dir.js'
import { claimForSandboxUser } from '../../../utils/sandbox-owner.js'
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

function ownerSlug(ownerEmail: string): string {
  const slug = slugifyEmail(ownerEmail)
  if (!slug || (slug === 'user' && !ownerEmail.trim())) {
    throw new Error('Cloud workspace is missing an owner email')
  }
  if (slug.includes('/') || slug.includes('..')) {
    throw new Error(`Refusing user directory slug: ${JSON.stringify(slug)}`)
  }
  return slug
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
    this.userMountRoots()
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

  /**
   * Bind only the owner's `.ai-agent` into the sandbox at the same absolute
   * path the agent uses (`/workspace/users/<slug>/.ai-agent`), so skill and
   * memory paths need no translation. The source is a host path: dockerd
   * does not see the agent container's mount namespace. `WORKSPACES_HOST_PATH`
   * is the host directory the agent sees at `WORKSPACES_ROOT` (`/workspace`),
   * so the user directory is `<that>/users/<slug>`, not `<that>/<slug>`.
   */
  userBindMount(ownerEmail: string): string {
    const { hostRoot, usersRoot, rel } = this.userMountRoots()
    const slug = ownerSlug(ownerEmail)
    const appDir = getAppDirName()
    const source =
      rel && rel !== '.'
        ? `${hostRoot}/${rel}/${slug}/${appDir}`
        : `${hostRoot}/${slug}/${appDir}`
    const dest = `${usersRoot}/${slug}/${appDir}`
    return `type=bind,src=${source},dst=${dest}`
  }

  /** `<USERS_ROOT>/<slug>`: the user directory whose `.ai-agent` is mounted. */
  mountedUserHome(ownerEmail: string): string {
    const { usersRoot } = this.userMountRoots()
    return `${usersRoot}/${ownerSlug(ownerEmail)}`
  }

  /**
   * `WORKSPACES_HOST_PATH` and `USERS_ROOT` together locate a user's
   * `.ai-agent` on the host and in the sandbox. Both are required.
   */
  private userMountRoots(): {
    hostRoot: string
    usersRoot: string
    rel: string
  } {
    const hostRoot = this.config.workspacesHostPath?.replace(/\/+$/, '')
    if (
      !hostRoot ||
      !hostRoot.startsWith('/') ||
      hostRoot.split('/').includes('..')
    ) {
      throw new Error(
        'WORKSPACES_HOST_PATH is not set to an absolute host path. ' +
          'Set it to the host directory mounted at /workspace in the agent container ' +
          'before starting a cloud workspace.',
      )
    }
    const usersRoot = this.config.usersRoot
    if (!usersRoot) {
      throw new Error(
        'USERS_ROOT is not set. Cloud workspaces mount <USERS_ROOT>/<user>/.ai-agent ' +
          'and need the same users root the agent uses, e.g. USERS_ROOT=/workspace/users.',
      )
    }
    const rel = path.posix.relative(this.config.workspacesRoot, usersRoot)
    if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
      throw new Error(
        `USERS_ROOT ${usersRoot} is outside WORKSPACES_ROOT ${this.config.workspacesRoot}, ` +
          'so its host path under WORKSPACES_HOST_PATH is unknown',
      )
    }
    return { hostRoot, usersRoot, rel }
  }

  /**
   * The control plane runs as root and creates `.ai-agent` files mode 600.
   * The sandbox user cannot delete those files unless it owns them. Hand the
   * mounted `.ai-agent` to that user. Symlinks are left untouched.
   * A bind source must exist, so `.ai-agent` is created for a known user.
   */
  ensureSandboxOwnsAppDir(ownerEmail: string): void {
    const slug = slugifyEmail(ownerEmail)
    const [uidRaw, gidRaw] = this.config.user.split(':')
    const uid = Number(uidRaw)
    const gid = Number(gidRaw)
    const usersRoot = this.config.usersRoot
    if (
      !usersRoot ||
      !Number.isInteger(uid) ||
      !Number.isInteger(gid) ||
      uid < 0 ||
      gid < 0
    ) {
      return
    }
    const userDir = path.join(usersRoot, slug)
    const appDir = path.join(userDir, getAppDirName())
    let stat: fs.Stats
    try {
      const userStat = fs.lstatSync(userDir)
      if (!userStat.isDirectory() || userStat.isSymbolicLink()) return
      fs.mkdirSync(appDir, { mode: 0o700 })
    } catch {
      // Missing user directory, or `.ai-agent` already exists.
    }
    try {
      stat = fs.lstatSync(appDir)
    } catch {
      return
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    const stack = [appDir]
    while (stack.length > 0) {
      const current = stack.pop()!
      let currentStat: fs.Stats
      try {
        currentStat = fs.lstatSync(current)
      } catch {
        continue
      }
      if (currentStat.isSymbolicLink()) continue
      claimForSandboxUser(current, uid, gid)
      const bits = currentStat.mode & 0o777
      const ownerCanWrite = currentStat.isDirectory()
        ? (bits & 0o300) === 0o300
        : (bits & 0o200) !== 0
      if (!ownerCanWrite) {
        const mode = currentStat.isDirectory() ? bits | 0o700 : bits | 0o600
        try {
          fs.chmodSync(current, mode)
        } catch {
          // Ownership is what the sandbox needs; mode is a fallback.
        }
      }
      if (!currentStat.isDirectory()) continue
      for (const name of fs.readdirSync(current)) {
        stack.push(path.join(current, name))
      }
    }
  }

  runArgs(id: string, ownerEmail: string): string[] {
    const c = this.config
    const userMount = this.userBindMount(ownerEmail)
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
      '--mount',
      userMount,
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
  async ensureRunning(id: string, ownerEmail: string): Promise<void> {
    this.assertAvailable(id)
    this.ensureSandboxOwnsAppDir(ownerEmail)
    const pending = this.starting.get(id)
    if (pending) {
      await pending
      this.assertAvailable(id)
      return
    }
    const started = this.startIfNeeded(id, ownerEmail)
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

  private async startIfNeeded(id: string, ownerEmail: string): Promise<void> {
    this.assertAvailable(id)
    const current = await this.state(id)
    this.assertAvailable(id)
    if (current === 'running') return
    if (current === 'stopped') await this.removeContainer(id)
    await this.ensureNetwork()
    this.assertAvailable(id)
    await this.ensureVolume(id)
    this.assertAvailable(id)
    await dockerOk(this.run, this.runArgs(id, ownerEmail), {
      timeoutMs: 120_000,
    })
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
