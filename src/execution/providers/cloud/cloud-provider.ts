import type {
  ConnectOptions,
  EnvironmentConnection,
  EnvironmentDescriptor,
  EnvironmentProvider,
  FsPort,
  RuntimeAuth,
  RuntimePort,
  WorkerInstallInfo,
} from '../../types.js'
import { EnvironmentRegistry } from '../../environment-registry.js'
import { ShellFsPort } from '../../shell-fs.js'
import { StdioRuntimePort, bindStdioRuntime } from '../../stdio-runtime-port.js'
import { readWorkerVersion } from '../../worker-paths.js'
import { isValidWorkspaceId, type WorkspaceContainers } from './containers.js'

export const CLOUD_ENV_PREFIX = 'cloud:'

const CLOUD_CAPS = {
  canBrowseFs: true,
  canDeployWorker: false,
  canForwardPorts: false,
  requiresOnlineConnector: false,
  credentialMode: 'none' as const,
}

export function cloudEnvironmentId(workspaceId: string): string {
  return `${CLOUD_ENV_PREFIX}${workspaceId}`
}

/** Workspace id for a `cloud:<id>` environment id, else null. */
export function parseCloudEnvironmentId(
  environmentId: string | undefined | null,
): string | null {
  if (!environmentId?.startsWith(CLOUD_ENV_PREFIX)) return null
  const id = environmentId.slice(CLOUD_ENV_PREFIX.length)
  return isValidWorkspaceId(id) ? id : null
}

export type CloudWorkspaceSummary = {
  id: string
  name: string
  ready: boolean
}

export type CloudProviderOptions = {
  containers: WorkspaceContainers
  /** Workspace registry lookup; the provider owns no records itself. */
  lookup: (workspaceId: string) => CloudWorkspaceSummary | undefined
  /** Called whenever a workspace is used, for idle tracking. */
  onActivity?: (workspaceId: string) => void
}

type Endpoint = { workspaceId: string }

class CloudConnection implements EnvironmentConnection {
  readonly id = EnvironmentRegistry.newConnectionId('cloud')
  status: EnvironmentConnection['status'] = 'connected'
  private fsPort: FsPort | null = null

  constructor(
    readonly env: EnvironmentDescriptor,
    private opts: CloudProviderOptions,
  ) {}

  private get workspaceId(): string {
    return (this.env.endpoint as Endpoint).workspaceId
  }

  private touch(): void {
    this.opts.onActivity?.(this.workspaceId)
  }

  private assertReady(): void {
    const record = this.opts.lookup(this.workspaceId)
    if (!record?.ready) {
      throw new Error(
        `Cloud workspace is no longer available: ${this.workspaceId}`,
      )
    }
  }

  async ensureWorker(version: string): Promise<WorkerInstallInfo> {
    this.assertReady()
    // The Worker is baked into the workspace image; nothing to deploy.
    return {
      version,
      path: this.opts.containers.config.workerPath,
      freshlyInstalled: false,
    }
  }

  async openRuntime(cwd: string, _auth: RuntimeAuth): Promise<RuntimePort> {
    const { containers } = this.opts
    this.assertReady()
    await containers.ensureRunning(this.workspaceId)
    this.assertReady()
    this.touch()
    const child = containers.spawnExec(
      this.workspaceId,
      ['node', containers.config.workerPath, '--stdio'],
      { cwd, env: { WORKER_VERSION: readWorkerVersion() } },
    )
    if (!child.stdin || !child.stdout) {
      child.kill()
      throw new Error('Workspace worker stdio unavailable')
    }
    const workspace = { environmentId: this.env.id, cwd }
    const port = new StdioRuntimePort({
      workspace,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr ?? undefined,
      child,
    })
    port.onMessage(() => this.touch())
    await bindStdioRuntime(port, workspace, 60_000)
    return port
  }

  openFs(): FsPort {
    if (!this.fsPort) {
      const { containers } = this.opts
      const id = this.workspaceId
      this.fsPort = new ShellFsPort({
        ready: async () => {
          this.assertReady()
          await containers.ensureRunning(id)
          this.assertReady()
        },
        spawn: script => {
          this.assertReady()
          this.touch()
          return containers.spawnExec(id, ['sh', '-c', script])
        },
      })
    }
    return this.fsPort
  }
}

/**
 * Cloud workspaces: one Docker container per workspace, Worker over
 * `docker exec -i`. Environments are never listed globally: each belongs to
 * one tenant, and HTTP routes enforce ownership before resolving one.
 */
export class CloudProvider implements EnvironmentProvider {
  readonly kind = 'cloud' as const
  private connections = new Map<string, CloudConnection>()

  constructor(private opts: CloudProviderOptions) {}

  get containers(): WorkspaceContainers {
    return this.opts.containers
  }

  async list(): Promise<EnvironmentDescriptor[]> {
    return []
  }

  async resolve(input: string): Promise<EnvironmentDescriptor> {
    const workspaceId = parseCloudEnvironmentId(input.trim())
    const record = workspaceId ? this.opts.lookup(workspaceId) : undefined
    if (!workspaceId || !record) {
      throw new Error(`Cloud workspace not found: ${input}`)
    }
    if (!record.ready) {
      throw new Error(`Cloud workspace is not ready: ${record.name}`)
    }
    return {
      id: cloudEnvironmentId(workspaceId),
      kind: 'cloud',
      displayName: record.name,
      defaultCwd: this.opts.containers.config.repoDir,
      capabilities: CLOUD_CAPS,
      endpoint: { workspaceId } satisfies Endpoint,
    }
  }

  async connect(
    env: EnvironmentDescriptor,
    _opts?: ConnectOptions,
  ): Promise<EnvironmentConnection> {
    if (env.kind !== 'cloud') {
      throw new Error('CloudProvider cannot connect non-cloud env')
    }
    const workspaceId = (env.endpoint as Endpoint).workspaceId
    if (!this.opts.lookup(workspaceId)?.ready) {
      throw new Error(`Cloud workspace is no longer available: ${workspaceId}`)
    }
    const conn = new CloudConnection(env, this.opts)
    this.connections.set(conn.id, conn)
    return conn
  }

  async disconnect(connectionId: string): Promise<void> {
    const c = this.connections.get(connectionId)
    if (!c) return
    c.status = 'disconnected'
    this.connections.delete(connectionId)
  }
}
