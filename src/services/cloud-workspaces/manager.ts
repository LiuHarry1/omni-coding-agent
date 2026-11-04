import { randomBytes } from 'crypto'
import type { WorkspaceContainers } from '../../execution/providers/cloud/containers.js'
import {
  CloudProvider,
  cloudEnvironmentId,
} from '../../execution/providers/cloud/cloud-provider.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import {
  gitCloneAuthConfig,
  probeGitRepository,
  redactGitSecret,
  RepoProbeError,
  type RepoAccess,
} from './repo-access.js'
import type {
  CloudWorkspaceRecord,
  CloudWorkspaceSource,
  CloudWorkspaceStore,
} from './store.js'

/** Thrown for invalid requests; the HTTP layer maps `status` to the response. */
export class CloudWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'CloudWorkspaceError'
  }
}

export type CreateCloudWorkspaceInput = {
  ownerEmail: string
  ownerName?: string
  name?: string
  /** Public HTTPS repository; omitted → empty repository. */
  repoUrl?: string
  ref?: string
  /**
   * Clone credential. Held only for the in-flight import; never stored on
   * the workspace record or written into the remote URL.
   */
  gitToken?: string
}

export type { RepoAccess }

/** Already-validated URL in, access result out. Token is optional. */
export type RepoAccessProbe = (
  repoUrl: string,
  token?: string,
) => Promise<RepoAccess>

export type CloudWorkspaceManagerOptions = {
  store: CloudWorkspaceStore
  containers: WorkspaceContainers
  /** Defaults to a live smart-HTTP probe. Tests inject a stub. */
  probeRepo?: RepoAccessProbe
  now?: () => number
}

const MAX_NAME_LENGTH = 80
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/
const TOUCH_PERSIST_MS = 60_000

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function newWorkspaceId(): string {
  return randomBytes(8).toString('hex')
}

export function validateRepoUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new CloudWorkspaceError('Repository URL is not a valid URL', 400)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CloudWorkspaceError(
      'Only http:// and https:// repository URLs are supported',
      400,
    )
  }
  if (url.username || url.password) {
    throw new CloudWorkspaceError(
      'Repository URL must not contain credentials',
      400,
    )
  }
  if (url.search || url.hash) {
    throw new CloudWorkspaceError(
      'Repository URL must not contain a query or fragment',
      400,
    )
  }
  if (url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length < 1) {
    throw new CloudWorkspaceError('Repository URL has no repository path', 400)
  }
  return url.toString()
}

export function validateRef(raw: string | undefined): string | undefined {
  const ref = raw?.trim()
  if (!ref) return undefined
  if (!REF_RE.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new CloudWorkspaceError(`Invalid branch or tag: ${ref}`, 400)
  }
  return ref
}

function defaultName(source: CloudWorkspaceSource): string {
  if (source.kind === 'empty') return 'Blank workspace'
  const last = new URL(source.url).pathname
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .pop()
  return (last ?? 'Repository').replace(/\.git$/i, '') || 'Repository'
}

function publicError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split(/\r?\n/).slice(-6).join('\n').slice(0, 2000)
}

/**
 * Tenant-owned cloud workspaces: records, container lifecycle, and the
 * one-time repository import that creates a workspace.
 */
export class CloudWorkspaceManager {
  private readonly store: CloudWorkspaceStore
  readonly containers: WorkspaceContainers
  private readonly probeRepo: RepoAccessProbe
  private readonly now: () => number
  private readonly provisioning = new Map<string, Promise<void>>()
  private readonly deleting = new Map<string, Promise<void>>()
  private readonly lastActive = new Map<string, number>()
  private busyProbe: () => Set<string> = () => new Set()
  private beforeStop: (handle: WorkspaceHandle) => Promise<void> =
    async () => {}
  private afterReady: (handle: WorkspaceHandle) => void = () => {}

  constructor(opts: CloudWorkspaceManagerOptions) {
    this.store = opts.store
    this.containers = opts.containers
    this.probeRepo =
      opts.probeRepo ?? ((url, token) => probeGitRepository(url, token))
    this.now = opts.now ?? Date.now
  }

  private async callProbe(url: string, token?: string): Promise<RepoAccess> {
    try {
      return await this.probeRepo(url, token)
    } catch (err) {
      if (err instanceof RepoProbeError) {
        throw new CloudWorkspaceError(err.message, err.status)
      }
      throw err
    }
  }

  /** Anonymous access check used before the create dialog asks for a token. */
  async probeRepoAccess(repoUrl: string): Promise<RepoAccess> {
    const url = validateRepoUrl(repoUrl)
    return this.callProbe(url)
  }

  /**
   * Decide whether a clone may start. A public repository drops any token.
   * A repository that asks for login is refused, with no record written,
   * until a token survives a second probe.
   */
  async authorizeRepository(
    repoUrl: string,
    gitToken?: string,
  ): Promise<{ url: string; gitToken?: string }> {
    const url = validateRepoUrl(repoUrl)
    const anonymous = await this.callProbe(url)
    if (anonymous === 'not-found') {
      throw new CloudWorkspaceError('Repository not found', 404)
    }
    if (anonymous === 'public') return { url }
    const token = gitToken?.trim() ?? ''
    if (!token) {
      throw new CloudWorkspaceError(
        'This repository requires a sign-in token',
        400,
      )
    }
    if (token.length > 512 || /\s/.test(token)) {
      throw new CloudWorkspaceError('Git token was rejected', 400)
    }
    const authed = await this.callProbe(url, token)
    if (authed === 'not-found') {
      throw new CloudWorkspaceError('Repository not found', 404)
    }
    if (authed !== 'public') {
      throw new CloudWorkspaceError('Git token was rejected', 400)
    }
    return { url, gitToken: token }
  }

  get config() {
    return this.containers.config
  }

  /** Workspace ids with in-flight agent work; never reclaimed while busy. */
  setBusyProbe(probe: () => Set<string>): void {
    this.busyProbe = probe
  }

  /** Close control-plane runtimes before a container goes away. */
  setBeforeStop(hook: (handle: WorkspaceHandle) => Promise<void>): void {
    this.beforeStop = hook
  }

  /** Fire-and-forget warmup hook after a workspace becomes usable. */
  setAfterReady(hook: (handle: WorkspaceHandle) => void): void {
    this.afterReady = hook
  }

  /** A provisioning record without a live job was cut off by a restart. */
  failInterruptedProvisioning(): void {
    for (const record of this.store.list()) {
      if (record.status !== 'provisioning' || this.provisioning.has(record.id))
        continue
      this.update(record.id, {
        status: 'error',
        error: 'Import interrupted by a server restart. Delete and retry.',
      })
    }
  }

  createProvider(): CloudProvider {
    return new CloudProvider({
      containers: this.containers,
      lookup: id => {
        const record = this.get(id)
        return record
          ? { id, name: record.name, ready: record.status === 'ready' }
          : undefined
      },
      onActivity: id => this.touch(id),
    })
  }

  handleFor(id: string): WorkspaceHandle {
    return {
      environmentId: cloudEnvironmentId(id),
      cwd: this.config.repoDir,
    }
  }

  get(id: string): CloudWorkspaceRecord | undefined {
    if (this.deleting.has(id)) return undefined
    return this.store.get(id)
  }

  list(ownerEmail: string): CloudWorkspaceRecord[] {
    const owner = normalizeEmail(ownerEmail)
    return this.store
      .list()
      .filter(record => !this.deleting.has(record.id))
      .filter(r => normalizeEmail(r.ownerEmail) === owner)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  listAll(): CloudWorkspaceRecord[] {
    return this.store
      .list()
      .filter(record => !this.deleting.has(record.id))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  canAccess(
    record: CloudWorkspaceRecord,
    email: string | undefined,
    isSuper: boolean,
  ): boolean {
    if (isSuper) return true
    return (
      !!email && normalizeEmail(record.ownerEmail) === normalizeEmail(email)
    )
  }

  /** Validate input, persist a provisioning record, and start the import. */
  create(input: CreateCloudWorkspaceInput): CloudWorkspaceRecord {
    const ownerEmail = input.ownerEmail.trim()
    if (!ownerEmail) throw new CloudWorkspaceError('Missing owner', 400)
    if (this.list(ownerEmail).length >= this.config.maxPerUser) {
      throw new CloudWorkspaceError(
        `Workspace limit reached (${this.config.maxPerUser}). Delete one first.`,
        409,
      )
    }
    const ref = validateRef(input.ref)
    const source: CloudWorkspaceSource = input.repoUrl?.trim()
      ? {
          kind: 'git',
          url: validateRepoUrl(input.repoUrl),
          ...(ref ? { ref } : {}),
        }
      : { kind: 'empty' }
    const name = (input.name?.trim() || defaultName(source)).slice(
      0,
      MAX_NAME_LENGTH,
    )
    const now = this.now()
    const record: CloudWorkspaceRecord = {
      version: 1,
      id: newWorkspaceId(),
      ownerEmail,
      name,
      source,
      status: 'provisioning',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    this.store.put(record)
    const job = this.provision(record, input.ownerName, input.gitToken).finally(
      () => {
        this.provisioning.delete(record.id)
      },
    )
    this.provisioning.set(record.id, job)
    return record
  }

  /** Resolve once provisioning settles; throws when the workspace is unusable. */
  async waitReady(id: string): Promise<CloudWorkspaceRecord> {
    await this.provisioning.get(id)
    const record = this.get(id)
    if (!record) throw new CloudWorkspaceError('Workspace not found', 404)
    if (record.status !== 'ready') {
      throw new CloudWorkspaceError(
        `Workspace "${record.name}" is not ready: ${record.error ?? record.status}`,
        409,
      )
    }
    return record
  }

  /** The user's most recently used workspace, creating a blank one if none. */
  async ensureDefault(
    ownerEmail: string,
    ownerName?: string,
  ): Promise<CloudWorkspaceRecord> {
    const mine = this.list(ownerEmail)
    const ready = mine.find(r => r.status === 'ready')
    if (ready) return ready
    const pending = mine.find(r => r.status === 'provisioning')
    if (pending) return this.waitReady(pending.id)
    const created = this.create({ ownerEmail, ownerName })
    return this.waitReady(created.id)
  }

  private async provision(
    record: CloudWorkspaceRecord,
    ownerName?: string,
    gitToken?: string,
  ): Promise<void> {
    const { containers } = this
    const repoDir = this.config.repoDir
    try {
      if (this.deleting.has(record.id)) {
        throw new Error(`Cloud workspace was deleted: ${record.id}`)
      }
      await containers.ensureRunning(record.id)
      if (this.deleting.has(record.id)) {
        throw new Error(`Cloud workspace was deleted: ${record.id}`)
      }
      if (record.source.kind === 'git') {
        await containers.execOk(
          record.id,
          [
            'git',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.https.allow=always',
            '-c',
            'protocol.http.allow=always',
            ...(gitToken ? ['-c', gitCloneAuthConfig(gitToken)] : []),
            'clone',
            '--depth',
            '1',
            '--no-recurse-submodules',
            ...(record.source.ref ? ['--branch', record.source.ref] : []),
            '--',
            record.source.url,
            repoDir,
          ],
          {
            env: { GIT_TERMINAL_PROMPT: '0' },
            timeoutMs: this.config.cloneTimeoutMs,
          },
        )
      } else {
        await containers.execOk(record.id, ['git', 'init', '--quiet', repoDir])
      }
      await containers.execOk(record.id, [
        'git',
        '-C',
        repoDir,
        'config',
        'user.email',
        record.ownerEmail,
      ])
      await containers.execOk(record.id, [
        'git',
        '-C',
        repoDir,
        'config',
        'user.name',
        ownerName?.trim() || record.ownerEmail,
      ])
      this.update(record.id, { status: 'ready', error: undefined })
      this.afterReady({
        environmentId: cloudEnvironmentId(record.id),
        cwd: repoDir,
      })
    } catch (err) {
      const message = redactGitSecret(publicError(err), gitToken)
      console.warn(
        `[cloud-workspaces] provisioning ${record.id} failed: ${message}`,
      )
      this.update(record.id, { status: 'error', error: message })
      await containers.removeContainer(record.id).catch(() => {})
    }
  }

  private update(id: string, patch: Partial<CloudWorkspaceRecord>): void {
    if (this.deleting.has(id)) return
    const current = this.store.get(id)
    // Deleted while provisioning: nothing to record.
    if (!current) return
    this.store.put({ ...current, ...patch, updatedAt: this.now() })
  }

  rename(id: string, name: string): CloudWorkspaceRecord {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
    if (!trimmed) throw new CloudWorkspaceError('Name must not be empty', 400)
    this.update(id, { name: trimmed })
    const record = this.store.get(id)
    if (!record) throw new CloudWorkspaceError('Workspace not found', 404)
    return record
  }

  touch(id: string): void {
    const now = this.now()
    this.lastActive.set(id, now)
    const record = this.store.get(id)
    if (record && now - record.lastUsedAt >= TOUCH_PERSIST_MS) {
      this.store.put({ ...record, lastUsedAt: now })
    }
  }

  /** Stop the container; the volume (and so the repository) is kept. */
  async stop(id: string): Promise<void> {
    if (this.busyProbe().has(id)) {
      throw new CloudWorkspaceError(
        'A chat is still running in this workspace',
        409,
      )
    }
    await this.beforeStop(this.handleFor(id)).catch(() => {})
    await this.containers.removeContainer(id)
  }

  /** Delete the container, the volume, and the record. */
  async remove(id: string): Promise<void> {
    const pending = this.deleting.get(id)
    if (pending) return pending
    if (this.busyProbe().has(id)) {
      throw new CloudWorkspaceError(
        'A chat is still running in this workspace',
        409,
      )
    }
    if (!this.store.get(id)) {
      throw new CloudWorkspaceError('Workspace not found', 404)
    }

    // Establish the tombstone synchronously, before any close/remove await.
    this.containers.tombstone(id)
    const deletion = this.removeTombstoned(id).finally(() => {
      this.deleting.delete(id)
    })
    this.deleting.set(id, deletion)
    return deletion
  }

  private async removeTombstoned(id: string): Promise<void> {
    await this.beforeStop(this.handleFor(id)).catch(() => {})
    await this.containers.removeContainer(id)
    await this.provisioning.get(id)?.catch(() => {})
    // A provision/open already in progress may have reached Docker just before
    // the tombstone. Remove again after it settles, then remove its volume.
    await this.containers.removeContainer(id)
    await this.containers.removeVolume(id)
    this.store.delete(id)
    this.lastActive.delete(id)
  }

  async removeAllForOwner(ownerEmail: string): Promise<number> {
    const mine = this.list(ownerEmail)
    for (const record of mine) await this.remove(record.id)
    return mine.length
  }

  /** Remove containers idle longer than `idleMs`; returns the stopped ids. */
  async sweepIdle(): Promise<string[]> {
    const running = await this.containers.listRunning()
    const busy = this.busyProbe()
    const now = this.now()
    const stopped: string[] = []
    for (const id of running) {
      const record = this.store.get(id)
      if (!record) {
        // Container outlived its record (e.g. deleted during a crash).
        await this.containers.removeContainer(id).catch(() => {})
        stopped.push(id)
        continue
      }
      if (this.provisioning.has(id) || busy.has(id)) continue
      const last = this.lastActive.get(id) ?? record.lastUsedAt
      if (now - last < this.config.idleMs) continue
      try {
        await this.stop(id)
        stopped.push(id)
      } catch (err) {
        console.warn(
          `[cloud-workspaces] idle stop ${id} failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
    return stopped
  }
}
