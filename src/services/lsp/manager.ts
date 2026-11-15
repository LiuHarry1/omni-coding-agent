import { createHash } from 'crypto'
import type { LspServerConfig } from '../../core/types.js'
import {
  createLspServerManager,
  type LspServerManager,
} from './server-manager.js'
import type { LspServerState } from './types.js'
import { resetAllLSPDiagnosticState } from './LSPDiagnosticRegistry.js'
import { normalizeWorkspacePath } from '../../utils/workspace/path.js'

const managers = new Map<string, LspServerManager>()

/** Status row for Workspace panel / GET /lsp. */
export type LspServerStatus = {
  name: string
  state: LspServerState
  command: string
  args: string[]
  extensions: string[]
  languages: string[]
  error?: string
}

export function hasLspServers(
  servers: Record<string, LspServerConfig> | undefined,
): servers is Record<string, LspServerConfig> {
  return Boolean(servers && Object.keys(servers).length > 0)
}

/** @deprecated Prefer normalizeWorkspacePath from utils/workspace/path.js */
export function normalizeWorkspaceCwd(cwd: string): string {
  return normalizeWorkspacePath(cwd)
}

export function getLspWorkspaceKey(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): string {
  return createHash('sha256')
    .update(normalizeWorkspaceCwd(cwd))
    .update('\0')
    .update(stableStringify(servers ?? {}))
    .digest('hex')
}

export function getLspManager(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): LspServerManager | undefined {
  if (!hasLspServers(servers)) return undefined

  const key = getLspWorkspaceKey(cwd, servers)
  const existing = managers.get(key)
  if (existing) return existing

  const resolvedCwd = normalizeWorkspaceCwd(cwd)
  const manager = createLspServerManager(resolvedCwd, servers, key)
  managers.set(key, manager)
  console.log(
    `[lsp:diagnostics] manager created cwd=${resolvedCwd} servers=${Object.keys(servers).join(', ')}`,
  )
  return manager
}

/** Return existing manager only — does not create or start servers. */
export function peekLspManager(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): LspServerManager | undefined {
  if (!hasLspServers(servers)) return undefined
  return managers.get(getLspWorkspaceKey(cwd, servers))
}

/**
 * List configured LSP servers for a workspace with live runtime state.
 * Never-started servers report `stopped` (servers start lazily).
 */
export function getLspStatusForCwd(
  cwd: string,
  servers: Record<string, LspServerConfig> | undefined,
): LspServerStatus[] {
  if (!hasLspServers(servers)) return []

  const manager = peekLspManager(cwd, servers)
  if (manager) {
    return [...manager.getAllServers().values()]
      .map(instance => statusFromInstance(instance.name, instance))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  return Object.entries(servers)
    .map(([name, config]) => statusFromConfig(name, config))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function statusFromConfig(
  name: string,
  config: LspServerConfig,
): LspServerStatus {
  const extMap = config.extensionToLanguage ?? {}
  return {
    name,
    state: 'stopped',
    command: config.command,
    args: config.args ?? [],
    extensions: Object.keys(extMap),
    languages: [...new Set(Object.values(extMap))],
  }
}

function statusFromInstance(
  name: string,
  instance: {
    state: LspServerState
    lastError: Error | undefined
    config: {
      command: string
      args?: string[]
      extensionToLanguage: Record<string, string>
    }
  },
): LspServerStatus {
  const extMap = instance.config.extensionToLanguage ?? {}
  return {
    name,
    state: instance.state,
    command: instance.config.command,
    args: instance.config.args ?? [],
    extensions: Object.keys(extMap),
    languages: [...new Set(Object.values(extMap))],
    error: instance.lastError?.message,
  }
}

export async function shutdownAllLspManagers(): Promise<void> {
  const entries = [...managers.entries()]
  managers.clear()
  await Promise.allSettled(
    entries.map(async ([key, manager]) => {
      try {
        await manager.shutdown()
      } finally {
        resetAllLSPDiagnosticState(key)
      }
    }),
  )
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
