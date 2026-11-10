/**
 * Session storage under `{agentHome}/.ai-agent/projects/<sanitized>/`.
 * Pure path builders + location cache.
 *
 * Callers must register a SessionLocation before using sessionId-based helpers.
 * Miss does NOT invent a location.
 */
import * as path from 'path'
import { getAppDirName, getProcessAppDir } from '../utils/app-dir.js'
import { resolveAgentHome } from '../utils/request-scope.js'
import { sanitizePath } from '../utils/sanitize-path.js'
import { getDefaultWorkspace } from './workspace.js'
import { normalizeWorkspacePath } from './workspace-path.js'

export type SessionLocation = {
  projectKey: string
  agentHome: string
}

const locationCache = new Map<string, SessionLocation>()

export function registerSessionLocation(
  sessionId: string,
  loc: SessionLocation,
): void {
  locationCache.set(sessionId, {
    projectKey: loc.projectKey,
    agentHome: path.resolve(loc.agentHome),
  })
}

export function unregisterSessionLocation(sessionId: string): void {
  locationCache.delete(sessionId)
}

export function getCachedSessionLocation(
  sessionId: string,
): SessionLocation | undefined {
  return locationCache.get(sessionId)
}

export function clearSessionLocationCache(): void {
  locationCache.clear()
}

/** Re-export: cron / process data dir. */
export { getProcessAppDir }

/** `{agentHome}/.ai-agent/projects` */
export function getProjectsRoot(agentHome?: string): string {
  return path.join(resolveAgentHome(agentHome), getAppDirName(), 'projects')
}

/** `{agentHome}/.ai-agent/session-index.json` */
export function getSessionIndexPath(agentHome?: string): string {
  return path.join(
    resolveAgentHome(agentHome),
    getAppDirName(),
    'session-index.json',
  )
}

/** `{agentHome}/.ai-agent/projects/<projectKey>` */
export function getProjectSessionDir(
  projectKey: string,
  agentHome?: string,
): string {
  return path.join(getProjectsRoot(agentHome), projectKey)
}

/**
 * Session bucket key, decided when a session is created or bound and then
 * read back from the session index — never recomputed to locate a session.
 * Like Claude Code's `getProjectDir(originalCwd)`, local keys use the cwd
 * itself (no git lookup); Auto Memory separately keys on the git root.
 * Remote: `environmentId:cwd`.
 */
export function computeProjectKey(
  workspace?: { environmentId: string; cwd: string } | null,
  fallbackCwd?: string,
): string {
  if (workspace?.environmentId && workspace.environmentId !== 'local') {
    const remoteCwd = normalizeWorkspacePath(workspace.cwd)
    return sanitizePath(`${workspace.environmentId}:${remoteCwd}`)
  }
  const cwd = workspace?.cwd
    ? normalizeWorkspacePath(workspace.cwd)
    : path.resolve(fallbackCwd ?? getDefaultWorkspace())
  return sanitizePath(cwd)
}

export function requireSessionLocation(sessionId: string): SessionLocation {
  const cached = locationCache.get(sessionId)
  if (cached) return cached
  throw new Error(
    `No session location registered for ${sessionId}; create/getSession first`,
  )
}

export function sessionJsonlPath(
  loc: SessionLocation,
  sessionId: string,
): string {
  return path.join(
    getProjectSessionDir(loc.projectKey, loc.agentHome),
    `${sessionId}.jsonl`,
  )
}

export function sessionDataDir(
  loc: SessionLocation,
  sessionId: string,
): string {
  return path.join(
    getProjectSessionDir(loc.projectKey, loc.agentHome),
    sessionId,
  )
}

export function getSessionJsonlPath(
  sessionId: string,
  projectKey?: string,
  agentHome?: string,
): string {
  if (projectKey !== undefined && agentHome !== undefined) {
    return sessionJsonlPath({ projectKey, agentHome }, sessionId)
  }
  return sessionJsonlPath(requireSessionLocation(sessionId), sessionId)
}

export function getSessionDataDir(
  sessionId: string,
  projectKey?: string,
  agentHome?: string,
): string {
  if (projectKey !== undefined && agentHome !== undefined) {
    return sessionDataDir({ projectKey, agentHome }, sessionId)
  }
  return sessionDataDir(requireSessionLocation(sessionId), sessionId)
}

export function getToolResultFilePath(
  sessionId: string,
  toolCallId: string,
  projectKey?: string,
  agentHome?: string,
): string {
  const safe = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(
    getSessionDataDir(sessionId, projectKey, agentHome),
    'tool-results',
    `${safe}.txt`,
  )
}

/** Scratch under user app dir when no session (e.g. WebFetch without session). */
export function getScratchDataDir(kind: string): string {
  const safe = kind.replace(/[^a-zA-Z0-9_-]/g, '_') || 'scratch'
  return path.join(resolveAgentHome(), getAppDirName(), 'scratch', safe)
}

/** `{agentHome}/.ai-agent/browser-logs` — spill dir (not under projects/). */
export function getBrowserLogsDir(agentHome?: string): string {
  return path.join(resolveAgentHome(agentHome), getAppDirName(), 'browser-logs')
}

/** `{agentHome}/.ai-agent/browser-logs/<sessionId>` */
export function getBrowserLogsSessionDir(
  sessionId: string,
  agentHome?: string,
): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'
  return path.join(getBrowserLogsDir(agentHome), safe)
}

/** `{agentHome}/.ai-agent/uploads` — chat attachments (not under projects/). */
export function getChatUploadsRoot(agentHome?: string): string {
  return path.join(resolveAgentHome(agentHome), getAppDirName(), 'uploads')
}

/** `{agentHome}/.ai-agent/uploads/<sessionId>` */
export function getChatUploadsSessionDir(
  sessionId: string,
  agentHome?: string,
): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'
  return path.join(getChatUploadsRoot(agentHome), safe)
}

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Models often rebuild `{agentHome}/.ai-agent/projects/<key>/…` from cwd
 * (memory / tool-result spill paths) and keep characters `sanitizePath`
 * would strip (e.g. `harry.liu` vs `harry-liu`), or split the key into
 * folders (`projects/C--Users/harry.liu/.ai-agent/workspace/<uuid>/…`).
 * Rewrite the project-key segment(s); return null when it would not change.
 *
 * Pure rewrite — callers must exists-gate (see FileRead `resolveFileInCwd`).
 * Does not consult the session location cache (that would be an IDOR if a
 * request included another session's UUID).
 */
export function coerceSanitizedProjectsPath(absPath: string): string | null {
  const normalized = path.normalize(path.resolve(absPath))
  const parts = normalized.split(path.sep)
  const app = getAppDirName()
  const i = parts.findIndex(
    (p, idx) => p === app && parts[idx + 1] === 'projects',
  )
  if (i < 0 || i + 2 >= parts.length) return null
  const after = parts.slice(i + 2)
  const uuidIdx = after.findIndex(p => SESSION_ID_RE.test(p))
  let next: string[]
  if (uuidIdx > 1) {
    const key = sanitizePath(after.slice(0, uuidIdx).join(path.sep))
    next = [...parts.slice(0, i + 2), key, ...after.slice(uuidIdx)]
  } else {
    const key = parts[i + 2]
    if (!key) return null
    const sanitized = sanitizePath(key)
    if (sanitized === key) return null
    next = parts.slice()
    next[i + 2] = sanitized
  }
  const out = next.join(path.sep)
  if (out === normalized) return null
  return out
}

function isUnderRoot(absPath: string, root: string): boolean {
  const normalized = path.normalize(path.resolve(absPath))
  const r = path.normalize(path.resolve(root))
  const prefix = r.endsWith(path.sep) ? r : r + path.sep
  return normalized === r || normalized.startsWith(prefix)
}

/**
 * Internal readable roots for the current agent home only
 * (projects + plans + scratch + browser-logs + uploads + skills + plugins).
 * settings.json and session transcripts outside projects/ stay excluded.
 * No substring matching across tenants.
 */
export function isReadableInternalPath(absPath: string): boolean {
  const normalized = path.normalize(path.resolve(absPath))
  try {
    const home = resolveAgentHome()
    const app = getAppDirName()
    const projects = getProjectsRoot(home)
    const plans = path.join(home, app, 'plans')
    const scratch = path.join(home, app, 'scratch')
    const skills = path.join(home, app, 'skills')
    const plugins = path.join(home, app, 'plugins')
    const browserLogs = getBrowserLogsDir(home)
    const uploads = getChatUploadsRoot(home)
    return (
      isUnderRoot(normalized, projects) ||
      isUnderRoot(normalized, plans) ||
      isUnderRoot(normalized, scratch) ||
      isUnderRoot(normalized, skills) ||
      isUnderRoot(normalized, plugins) ||
      isUnderRoot(normalized, browserLogs) ||
      isUnderRoot(normalized, uploads)
    )
  } catch {
    return false
  }
}
