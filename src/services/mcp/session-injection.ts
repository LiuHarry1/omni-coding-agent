import type { MCPServerHTTP } from '../../core/types.js'
import type { CloudWorkspaceRecord } from '../cloud-workspaces/store.js'
import { workspaceOrigin } from '../cloud-workspaces/manager.js'
import { filterHttpMCPServers } from './policy.js'

/**
 * MCP servers a caller attaches to one session (KnowBot Work tasks carry the
 * assistant's knowledge-base tools this way). Accepted only for chatbot-origin
 * cloud workspaces, so direct cloud users and desktop never see them.
 */

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export class InjectedMcpError extends Error {}

function isSessionMcpInjectionEnabled(): boolean {
  const raw = (process.env.SESSION_MCP_INJECTION_ENABLED ?? '').trim()
  return raw === '1' || raw.toLowerCase() === 'true'
}

function sanitizeServer(raw: Record<string, unknown>): MCPServerHTTP {
  const server: MCPServerHTTP = { url: String(raw.url) }
  if (raw.transport === 'http' || raw.transport === 'sse') {
    server.transport = raw.transport
  }
  if (raw.headers && typeof raw.headers === 'object') {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
    if (Object.keys(headers).length > 0) server.headers = headers
  }
  return server
}

/**
 * Validate a request's `mcpServers` for the session's bound workspace.
 * Throws {@link InjectedMcpError} when the field must be rejected.
 */
export function validateInjectedMcpServers(
  raw: unknown,
  record: Pick<CloudWorkspaceRecord, 'origin' | 'name'> | undefined,
): Record<string, MCPServerHTTP> {
  if (!isSessionMcpInjectionEnabled()) {
    throw new InjectedMcpError('mcpServers is not enabled on this server')
  }
  if (!record || workspaceOrigin(record) !== 'chatbot') {
    throw new InjectedMcpError(
      'mcpServers is only accepted for chatbot workspaces',
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InjectedMcpError('mcpServers must be an object')
  }
  const candidates: Record<string, MCPServerHTTP> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      throw new InjectedMcpError(`Invalid MCP server name '${name}'`)
    }
    if (!value || typeof value !== 'object') {
      throw new InjectedMcpError(`MCP server '${name}' must be an object`)
    }
    candidates[name] = sanitizeServer(value as Record<string, unknown>)
  }
  const { servers, dropped } = filterHttpMCPServers(candidates)
  if (dropped.length > 0) {
    throw new InjectedMcpError(
      `MCP servers must use http(s): ${dropped.join(', ')}`,
    )
  }
  return servers
}
