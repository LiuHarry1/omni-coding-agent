import { randomUUID } from 'crypto'
import type {
  ConnectOptions,
  EnvironmentConnection,
  EnvironmentDescriptor,
  EnvironmentId,
  EnvironmentKind,
  EnvironmentProvider,
} from './types.js'

/**
 * Aggregates EnvironmentProviders. Control Plane talks only to this registry.
 */
export class EnvironmentRegistry {
  private providers = new Map<EnvironmentKind, EnvironmentProvider>()
  private connections = new Map<string, EnvironmentConnection>()
  /** environmentId → active connection id */
  private envConnection = new Map<EnvironmentId, string>()

  register(provider: EnvironmentProvider): void {
    this.providers.set(provider.kind, provider)
  }

  getProvider(kind: EnvironmentKind): EnvironmentProvider | undefined {
    return this.providers.get(kind)
  }

  async listAll(): Promise<EnvironmentDescriptor[]> {
    const out: EnvironmentDescriptor[] = []
    for (const p of this.providers.values()) {
      out.push(...(await p.list()))
    }
    return out
  }

  /**
   * Resolve user input. Tries providers in kind order: local → ssh → others.
   * Bare paths / "local" → local. `user@host` / HostName → ssh.
   */
  async resolve(input: string): Promise<EnvironmentDescriptor> {
    const trimmed = input.trim()
    if (!trimmed) throw new Error('Empty environment input')

    if (trimmed === 'local' || trimmed.startsWith('local:')) {
      const local = this.providers.get('local')
      if (!local) throw new Error('LocalProvider not registered')
      return local.resolve(trimmed)
    }

    // Never fall through to other providers: `cloud:<id>` would otherwise
    // parse as an SSH host alias.
    if (trimmed.startsWith('cloud:')) {
      const cloud = this.providers.get('cloud')
      if (!cloud) throw new Error('Cloud workspaces are not enabled')
      return cloud.resolve(trimmed)
    }

    // Absolute / relative filesystem paths → local
    if (
      trimmed.startsWith('/') ||
      trimmed.startsWith('.') ||
      trimmed.startsWith('~') ||
      /^[A-Za-z]:[\\/]/.test(trimmed)
    ) {
      const local = this.providers.get('local')
      if (local) {
        try {
          return await local.resolve(trimmed)
        } catch {
          /* fall through */
        }
      }
    }

    if (
      trimmed.startsWith('ssh:') ||
      trimmed.includes('@') ||
      (!trimmed.includes('://') &&
        !trimmed.includes('/') &&
        !trimmed.includes('\\'))
    ) {
      const ssh = this.providers.get('ssh')
      if (ssh) {
        try {
          return await ssh.resolve(
            trimmed.startsWith('ssh:') ? trimmed.slice(4) : trimmed,
          )
        } catch {
          /* fall through */
        }
      }
    }

    for (const p of this.providers.values()) {
      try {
        return await p.resolve(trimmed)
      } catch {
        /* try next */
      }
    }
    throw new Error(`Cannot resolve environment: ${trimmed}`)
  }

  async connect(
    envOrId: EnvironmentDescriptor | EnvironmentId,
    opts?: ConnectOptions,
  ): Promise<EnvironmentConnection> {
    const env =
      typeof envOrId === 'string'
        ? ((await this.listAll()).find(e => e.id === envOrId) ??
          (await this.resolve(envOrId)))
        : envOrId

    const existingId = this.envConnection.get(env.id)
    if (existingId) {
      const existing = this.connections.get(existingId)
      if (existing && existing.status === 'connected') return existing
    }

    const provider = this.providers.get(env.kind)
    if (!provider) {
      throw new Error(`No provider for environment kind: ${env.kind}`)
    }

    const conn = await provider.connect(env, opts)
    this.connections.set(conn.id, conn)
    this.envConnection.set(env.id, conn.id)
    return conn
  }

  getConnection(connectionId: string): EnvironmentConnection | undefined {
    return this.connections.get(connectionId)
  }

  getConnectionForEnv(
    environmentId: EnvironmentId,
  ): EnvironmentConnection | undefined {
    const id = this.envConnection.get(environmentId)
    return id ? this.connections.get(id) : undefined
  }

  async disconnect(connectionId: string): Promise<void> {
    const conn = this.connections.get(connectionId)
    if (!conn) return
    const provider = this.providers.get(conn.env.kind)
    await provider?.disconnect(connectionId)
    this.connections.delete(connectionId)
    if (this.envConnection.get(conn.env.id) === connectionId) {
      this.envConnection.delete(conn.env.id)
    }
  }

  /** Close every cached connection for one environment id. */
  async disconnectEnvironment(environmentId: EnvironmentId): Promise<void> {
    const ids = [...this.connections]
      .filter(([, connection]) => connection.env.id === environmentId)
      .map(([id]) => id)
    for (const id of ids) await this.disconnect(id)
    this.envConnection.delete(environmentId)
  }

  /** Test helper / unique connection ids. */
  static newConnectionId(kind: EnvironmentKind): string {
    return `${kind}:${randomUUID()}`
  }
}
