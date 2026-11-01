import { CredentialBroker } from './credential-broker.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { RuntimeBroker } from './runtime-broker.js'
import { WorkspaceService } from './workspace-service.js'
import { PermissionGateway } from './permission-gateway.js'
import { LocalProvider } from './providers/local/local-provider.js'
import { SshProvider } from './providers/ssh/ssh-provider.js'
import type { SshSettingsEntry } from './providers/ssh/ssh-config.js'
import type { EnvironmentProvider } from './types.js'

export type ExecutionPlane = {
  registry: EnvironmentRegistry
  credentials: CredentialBroker
  runtimes: RuntimeBroker
  workspaces: WorkspaceService
  permissions: PermissionGateway
  ssh: SshProvider
  local: LocalProvider
}

let singleton: ExecutionPlane | null = null

export type BootstrapOptions = {
  sshHosts?: SshSettingsEntry[]
  /** Start local AuthProxy (default true). */
  startAuthProxy?: boolean
  /**
   * Replaces the local + SSH providers. Cloud deployments pass only the
   * container provider so no tool can resolve to the control-plane host.
   */
  providers?: EnvironmentProvider[]
}

/**
 * Create (once) the execution control-plane services.
 */
export async function bootstrapExecutionPlane(
  opts?: BootstrapOptions,
): Promise<ExecutionPlane> {
  if (singleton) {
    if (opts?.sshHosts) singleton.ssh.setSettingsHosts(opts.sshHosts)
    return singleton
  }

  const registry = new EnvironmentRegistry()
  const local = new LocalProvider()
  const ssh = new SshProvider({ settingsHosts: opts?.sshHosts ?? [] })
  if (opts?.providers) {
    for (const provider of opts.providers) registry.register(provider)
  } else {
    registry.register(local)
    registry.register(ssh)
  }

  const credentials = new CredentialBroker()
  if (opts?.startAuthProxy !== false) {
    try {
      await credentials.startAuthProxy()
    } catch (err) {
      console.warn(
        '[execution] AuthProxy failed to start:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  const runtimes = new RuntimeBroker(registry, credentials)
  const workspaces = new WorkspaceService(registry)
  const permissions = new PermissionGateway()

  singleton = {
    registry,
    credentials,
    runtimes,
    workspaces,
    permissions,
    ssh,
    local,
  }
  return singleton
}

export function getExecutionPlane(): ExecutionPlane {
  if (!singleton) {
    throw new Error(
      'Execution plane not bootstrapped — call bootstrapExecutionPlane() at server start',
    )
  }
  return singleton
}

export async function shutdownExecutionPlane(): Promise<void> {
  if (!singleton) return
  await singleton.runtimes.closeAll()
  await singleton.credentials.stopAuthProxy()
  singleton = null
}
