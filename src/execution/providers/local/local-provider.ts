import * as fs from 'fs/promises'
import * as path from 'path'
import { spawn } from 'child_process'
import type {
  ConnectOptions,
  DirEntry,
  EnvironmentConnection,
  EnvironmentDescriptor,
  EnvironmentProvider,
  FileStat,
  FsPort,
  ReadOpts,
  RuntimeAuth,
  RuntimePort,
  WorkerInstallInfo,
} from '../../types.js'
import { EnvironmentRegistry } from '../../environment-registry.js'
import { getDefaultWorkspace } from '../../../utils/workspace/workspace.js'
import {
  resolveWorkerLaunch,
  readWorkerVersion,
  getRepoRoot,
  buildAgentSpawnEnv,
} from '../../worker-paths.js'
import { StdioRuntimePort, bindStdioRuntime } from '../../stdio-runtime-port.js'
import { getAgentHome } from '../../../utils/workspace/request-scope.js'

/**
 * A local worker either starts in a couple of seconds or is misconfigured.
 * Remote (SSH) keeps a much longer budget — see ssh-stdio-session.
 */
const LOCAL_BIND_TIMEOUT_MS = 15_000

const LOCAL_CAPS = {
  canBrowseFs: true,
  canDeployWorker: true,
  canForwardPorts: false,
  requiresOnlineConnector: false,
  credentialMode: 'none' as const,
}

function localDescriptor(defaultCwd?: string): EnvironmentDescriptor {
  return {
    id: 'local',
    kind: 'local',
    displayName: 'This machine',
    defaultCwd: defaultCwd ?? getDefaultWorkspace(),
    capabilities: LOCAL_CAPS,
    endpoint: { type: 'local' },
  }
}

class LocalFsPort implements FsPort {
  async list(dirPath: string): Promise<DirEntry[]> {
    const abs = path.resolve(dirPath)
    const names = await fs.readdir(abs)
    const out: DirEntry[] = []
    for (const name of names) {
      const full = path.join(abs, name)
      let type: DirEntry['type'] = 'other'
      try {
        const st = await fs.stat(full)
        type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
      } catch {
        /* ignore */
      }
      out.push({ name, path: full, type })
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return out
  }

  async stat(filePath: string): Promise<FileStat> {
    const abs = path.resolve(filePath)
    const st = await fs.stat(abs)
    return {
      path: abs,
      type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtimeMs: st.mtimeMs,
    }
  }

  async read(filePath: string, opts?: ReadOpts): Promise<Uint8Array | string> {
    const abs = path.resolve(filePath)
    if (opts?.encoding) return fs.readFile(abs, { encoding: opts.encoding })
    const buf = await fs.readFile(abs)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async realpath(filePath: string): Promise<string> {
    return fs.realpath(path.resolve(filePath))
  }

  async close(): Promise<void> {}
}

class LocalConnection implements EnvironmentConnection {
  readonly id: string
  readonly env: EnvironmentDescriptor
  status: EnvironmentConnection['status'] = 'connected'
  private fsPort: LocalFsPort | null = null

  constructor(env: EnvironmentDescriptor) {
    this.id = EnvironmentRegistry.newConnectionId('local')
    this.env = env
  }

  async ensureWorker(desiredVersion: string): Promise<WorkerInstallInfo> {
    const launch = resolveWorkerLaunch()
    return {
      version: desiredVersion || launch.version,
      path: launch.artifactPath,
      freshlyInstalled: false,
    }
  }

  async openRuntime(cwd: string, _auth: RuntimeAuth): Promise<RuntimePort> {
    const resolved = await fs
      .realpath(path.resolve(cwd))
      .catch(() => path.resolve(cwd))
    const launch = resolveWorkerLaunch()
    // Pin logical HOME into the worker so prepareShellSpawn/getShellHome
    // see the tenant workspace (worker has AUTH_ENABLED but no ALS).
    let agentHome: string | undefined
    try {
      agentHome = getAgentHome()
    } catch {
      agentHome = undefined
    }
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: buildAgentSpawnEnv(
        {
          ...process.env,
          ...(agentHome
            ? {
                HOME: agentHome,
                ...(process.platform === 'win32'
                  ? { USERPROFILE: agentHome }
                  : {}),
              }
            : {}),
          WORKER_VERSION: launch.version,
        },
        getRepoRoot(),
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (!child.stdin || !child.stdout) {
      child.kill()
      throw new Error('Local worker stdio unavailable')
    }
    const workspace = {
      environmentId: this.env.id,
      cwd: resolved,
    }
    const port = new StdioRuntimePort({
      workspace,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr ?? undefined,
      child,
    })
    try {
      await bindStdioRuntime(port, workspace, LOCAL_BIND_TIMEOUT_MS)
    } catch (err) {
      // Nothing caches a port that never bound, so leaving it open would leak
      // one worker process per attempt.
      await port.close().catch(() => {})
      throw new Error(
        `Local worker failed to bind (${launch.mode}: ${launch.command}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    return port
  }

  openFs(): FsPort {
    if (!this.fsPort) this.fsPort = new LocalFsPort()
    return this.fsPort
  }
}

export class LocalProvider implements EnvironmentProvider {
  readonly kind = 'local' as const
  private connections = new Map<string, LocalConnection>()

  async list(): Promise<EnvironmentDescriptor[]> {
    return [localDescriptor()]
  }

  async resolve(input: string): Promise<EnvironmentDescriptor> {
    const t = input.trim()
    if (t === 'local' || t === 'local:' || t.startsWith('local:')) {
      const cwd = t.startsWith('local:') ? t.slice('local:'.length) : undefined
      return localDescriptor(cwd || undefined)
    }
    if (path.isAbsolute(t) || t.startsWith('.') || t.startsWith('~')) {
      return localDescriptor(t)
    }
    if (t === '.' || t === '') return localDescriptor()
    throw new Error(`Not a local environment: ${input}`)
  }

  async connect(
    env: EnvironmentDescriptor,
    _opts?: ConnectOptions,
  ): Promise<EnvironmentConnection> {
    if (env.kind !== 'local') {
      throw new Error('LocalProvider cannot connect non-local env')
    }
    const conn = new LocalConnection(env)
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

export function createLocalEnvironmentId(): string {
  return 'local'
}

// re-export for version helpers used in tests
export { readWorkerVersion }
