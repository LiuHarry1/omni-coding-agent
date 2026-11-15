/**
 * Per-request scope (AUTH/SSO): logical HOME + project cwd in one ALS.
 *
 * - agentHome: ~, getUserAppDir, bash $HOME
 * - cwd: tool/project workspace (SSO often equals agentHome; local often not)
 *
 * AUTH off: getAgentHome() → os.homedir(); cwd usually comes from HTTP/params
 * (no ALS required). AUTH on + no scope → getAgentHome fail-closed.
 *
 * Managed/policy paths (`getManagedDir`) must never use this.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as os from 'os'
import * as path from 'path'
import { normalizeWorkspacePath } from './path.js'
import { isAuthEnabled } from '../env.js'

export type RequestScope = {
  /** Logical HOME for user-scope app-dir, tilde expand, shell $HOME. */
  agentHome: string
  /** Tool / project cwd (File tools, shell cwdRef start, most workspace APIs). */
  cwd: string
}

const requestScopeAls = new AsyncLocalStorage<RequestScope>()

/** Run `fn` with request scope bound for the current async context. */
export function runWithRequestScope<T>(scope: RequestScope, fn: () => T): T {
  const resolved: RequestScope = {
    // agentHome is always a host-local path (SSO pin / os.homedir).
    agentHome: path.resolve(scope.agentHome),
    // cwd may be a remote POSIX path when AUTH wraps an SSH session — never
    // Win32-resolve those (would turn /home/... into C:\home\...).
    cwd: normalizeWorkspacePath(scope.cwd),
  }
  return requestScopeAls.run(resolved, fn)
}

/** Raw ALS store (undefined when AUTH off or outside a bound request). */
export function getRequestScope(): RequestScope | undefined {
  return requestScopeAls.getStore()
}

/**
 * Logical HOME. AUTH off → os.homedir(). AUTH on → ALS agentHome or throw.
 */
export function getAgentHome(): string {
  if (!isAuthEnabled()) {
    return os.homedir()
  }
  const scope = requestScopeAls.getStore()
  if (!scope?.agentHome) {
    throw new Error(
      'getAgentHome() called with AUTH_ENABLED but no agent home in context; wrap the request with runWithRequestScope({ agentHome, cwd })',
    )
  }
  return scope.agentHome
}

/**
 * Resolve agent home for path layout. Explicit override wins; else getAgentHome();
 * AUTH-off / no ALS falls back to os.homedir() without throwing.
 */
export function resolveAgentHome(explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  try {
    return getAgentHome()
  } catch {
    return os.homedir()
  }
}

/**
 * Request cwd from ALS. AUTH on → scope.cwd or throw.
 * AUTH off → throw unless a scope was explicitly entered (e.g. tests/boot).
 */
export function getRequestCwd(): string {
  const scope = requestScopeAls.getStore()
  if (scope?.cwd) return scope.cwd
  if (isAuthEnabled()) {
    throw new Error(
      'getRequestCwd() called with AUTH_ENABLED but no request scope; wrap with runWithRequestScope({ agentHome, cwd })',
    )
  }
  throw new Error(
    'getRequestCwd() called with no request scope; pass cwd explicitly or enter runWithRequestScope',
  )
}

/**
 * HOME for local shell spawn. Prefer ALS; under AUTH outside ALS (worker
 * child), use process.env.HOME pinned by LocalProvider at runtime open.
 */
export function getShellHome(): string {
  try {
    return getAgentHome()
  } catch (err) {
    if (isAuthEnabled()) {
      const pinned = process.env.HOME?.trim()
      if (pinned) return path.resolve(pinned)
    }
    throw err
  }
}
