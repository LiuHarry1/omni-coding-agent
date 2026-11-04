import * as crypto from 'crypto'
import * as path from 'path'
import { MCPManager } from './mcp-manager.js'
import { filterHttpMCPServers } from './mcp-policy.js'
import type { MCPServerConfig } from './types.js'
import { isCloudWorkspacesEnabled } from '../execution/providers/cloud/config.js'

interface ManagedMCPPoolEntry {
  manager: MCPManager
  lastUsed: number
  cwd: string
}

const managers = new Map<string, ManagedMCPPoolEntry>()
const opening = new Map<string, Promise<MCPManager>>()
const IDLE_TTL_MS = 30 * 60 * 1000

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function poolKey(
  cwd: string,
  servers: Record<string, MCPServerConfig>,
): string {
  return crypto
    .createHash('sha256')
    .update(cwd)
    .update('\0')
    .update(stableStringify(servers))
    .digest('hex')
}

function sweepIdleManagers(): void {
  const now = Date.now()
  for (const [key, entry] of managers) {
    if (now - entry.lastUsed <= IDLE_TTL_MS) continue
    managers.delete(key)
    entry.manager.closeAll().catch(() => {})
  }
}

/** clear stale MCP connections after settings write. */
export function invalidateMCPManagersForCwd(cwd: string): void {
  const resolved = path.resolve(cwd)
  for (const [key, entry] of managers) {
    if (entry.cwd !== resolved) continue
    managers.delete(key)
    entry.manager.closeAll().catch(() => {})
  }
}

export async function getMCPManagerForServers(
  cwd: string,
  servers: Record<string, MCPServerConfig>,
): Promise<MCPManager> {
  sweepIdleManagers()
  let effectiveServers = servers
  if (isCloudWorkspacesEnabled()) {
    const filtered = filterHttpMCPServers(servers)
    effectiveServers = filtered.servers
    if (filtered.dropped.length > 0) {
      console.warn(
        `[mcp] cloud runtime rejected non-HTTP servers: ${filtered.dropped.join(', ')}`,
      )
    }
  }
  const key = poolKey(cwd, effectiveServers)
  const existing = managers.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.manager
  }

  const pending = opening.get(key)
  if (pending) return pending

  const create = (async () => {
    const manager = new MCPManager()
    try {
      await Promise.all(
        Object.entries(effectiveServers).map(([name, config]) =>
          manager.addServer(name, config),
        ),
      )
    } catch (error) {
      await manager.closeAll().catch(() => {})
      throw error
    }
    managers.set(key, {
      manager,
      lastUsed: Date.now(),
      cwd: path.resolve(cwd),
    })
    return manager
  })()
  opening.set(key, create)
  try {
    return await create
  } finally {
    if (opening.get(key) === create) opening.delete(key)
  }
}

export function initMcpLifecycle(): void {
  process.on('exit', () => {
    for (const entry of managers.values()) {
      entry.manager.closeAll().catch(() => {})
    }
  })
}
