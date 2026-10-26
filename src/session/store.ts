import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { Session, SessionInfo, Message } from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import { isCompactBoundaryMessage } from '../core/messages/compact-boundary.js'
import type { ExternalMode } from '../core/permission-mode.js'
import { createDefaultPermissionMode } from '../core/permission-mode.js'
import { resetSessionMemoryState } from '../services/session-memory/state.js'
import { resetAutoMemoryState } from '../services/auto-memory/state.js'
import { resetMicroCompactState } from '../services/compact/microCompact.js'
import { removeTasksForSession } from '../services/cron/store.js'
import {
  computeProjectKey,
  getCachedSessionLocation,
  getChatUploadsSessionDir,
  getProjectSessionDir,
  getSessionDataDir,
  getSessionJsonlPath,
  getToolResultFilePath,
  registerSessionLocation,
  unregisterSessionLocation,
  type SessionLocation,
} from '../core/session-paths.js'
import { getDefaultWorkspace } from '../core/workspace.js'
import { normalizeWorkspacePath } from '../core/workspace-path.js'
import { resolveAgentHome } from '../utils/request-scope.js'
import {
  findSessionLocation,
  listSessionAgentHomes,
  readSessionIndex,
  removeSessionIndexEntry,
  upsertSessionIndexEntry,
} from './session-index.js'
import {
  parseSessionJsonLine,
  stringifySessionJsonLine,
} from './json-serialize.js'
import { projectMessageForDisk } from './persist-project.js'
import { replayTranscriptMessages } from './compact-replay.js'
import { restoreInvokedSkillsFromMessages } from '../skills/invoked-skills.js'

const sessions = new Map<string, Session>()

export { getToolResultFilePath }

/** Resolve location from cache or index; never invent. */
function locationFor(sessionId: string): SessionLocation {
  const cached = getCachedSessionLocation(sessionId)
  if (cached) return cached
  const found = findSessionLocation(sessionId)
  if (found) {
    registerSessionLocation(sessionId, found)
    return found
  }
  throw new Error(
    `No session location for ${sessionId}; create/getSession first`,
  )
}

function sessionPath(id: string): string {
  const loc = locationFor(id)
  return getSessionJsonlPath(id, loc.projectKey, loc.agentHome)
}

function ensureProjectDir(loc: SessionLocation): void {
  fs.mkdirSync(getProjectSessionDir(loc.projectKey, loc.agentHome), {
    recursive: true,
  })
}

// ── In-flight turn mutex ────────────────────────

const activeTurns = new Set<string>()

/** Returns false when a turn is already running for this session. */
export function tryBeginTurn(sessionId: string): boolean {
  if (activeTurns.has(sessionId)) return false
  activeTurns.add(sessionId)
  return true
}

export function endTurn(sessionId: string): void {
  activeTurns.delete(sessionId)
}

export type CreateSessionOptions = {
  ownerEmail?: string
  /** Override agent home (cron / tests). Default: getAgentHome(). */
  agentHome?: string
  /** Initial project key cwd (before workspace_bound). */
  cwd?: string
}

export function createSession(
  ownerEmailOrOpts?: string | CreateSessionOptions,
): Session {
  const opts: CreateSessionOptions =
    typeof ownerEmailOrOpts === 'string' || ownerEmailOrOpts === undefined
      ? { ownerEmail: ownerEmailOrOpts }
      : ownerEmailOrOpts

  const id = randomUUID()
  const agentHome = resolveAgentHome(opts.agentHome)
  const projectKey = computeProjectKey(
    undefined,
    opts.cwd ?? getDefaultWorkspace(),
  )
  const loc: SessionLocation = { projectKey, agentHome }
  registerSessionLocation(id, loc)

  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    ownerEmail: opts.ownerEmail,
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    additionalWorkingDirectories: [],
    agentType: null,
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  }
  sessions.set(id, session)
  ensureProjectDir(loc)
  upsertSessionIndexEntry(
    id,
    {
      projectKey,
      createdAt: session.createdAt,
      ownerEmail: opts.ownerEmail,
    },
    agentHome,
  )
  appendLine(id, {
    type: 'session_created',
    id,
    createdAt: session.createdAt,
    ownerEmail: opts.ownerEmail ?? null,
    permissionMode: session.permissionMode,
    agentType: session.agentType,
  })
  return session
}

export type GetSessionOptions = {
  agentHome?: string
}

export function getSession(
  id: string,
  opts?: GetSessionOptions,
): Session | null {
  if (sessions.has(id)) return sessions.get(id)!

  const found = opts?.agentHome
    ? findSessionLocation(id, opts.agentHome)
    : (getCachedSessionLocation(id) ?? findSessionLocation(id))
  if (!found) return null
  registerSessionLocation(id, found)

  const filePath = getSessionJsonlPath(id, found.projectKey, found.agentHome)
  if (!fs.existsSync(filePath)) return null

  const session = restoreFromDisk(id)
  sessions.set(id, session)
  return session
}

function extractPreview(session: Session | null): string | undefined {
  if (!session) return undefined
  if (session.title?.trim()) return session.title.trim()
  const firstUser = session.messages.find(
    m => isRoleMessage(m) && m.role === 'user',
  )
  if (!firstUser) return undefined
  const text =
    typeof firstUser.content === 'string'
      ? firstUser.content
      : (firstUser.content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('')
  return text.slice(0, 80) || undefined
}

/** Persist an LLM-generated session title (append-only jsonl + in-memory). */
export function setSessionTitle(sessionId: string, title: string): void {
  const session = getSession(sessionId)
  if (!session) return
  const cleaned = title.trim()
  if (!cleaned) return
  session.title = cleaned
  appendLine(sessionId, {
    type: 'session_title',
    title: cleaned,
    timestamp: Date.now(),
  })
}

function relocateSessionFiles(
  sessionId: string,
  from: SessionLocation,
  to: SessionLocation,
): void {
  if (
    from.projectKey === to.projectKey &&
    path.resolve(from.agentHome) === path.resolve(to.agentHome)
  ) {
    return
  }
  ensureProjectDir(to)
  const oldJsonl = getSessionJsonlPath(
    sessionId,
    from.projectKey,
    from.agentHome,
  )
  const newJsonl = getSessionJsonlPath(sessionId, to.projectKey, to.agentHome)
  const oldData = getSessionDataDir(sessionId, from.projectKey, from.agentHome)
  const newData = getSessionDataDir(sessionId, to.projectKey, to.agentHome)

  if (fs.existsSync(oldJsonl)) {
    fs.renameSync(oldJsonl, newJsonl)
  }
  if (fs.existsSync(oldData)) {
    fs.renameSync(oldData, newData)
  }

  if (path.resolve(from.agentHome) !== path.resolve(to.agentHome)) {
    removeSessionIndexEntry(sessionId, from.agentHome)
  }
  registerSessionLocation(sessionId, to)
}

/** Bind a WorkspaceHandle to the session (persisted in jsonl). */
export function setSessionWorkspace(
  sessionId: string,
  workspace: import('../execution/types.js').WorkspaceHandle,
): void {
  const session = getSession(sessionId)
  if (!session) return

  const bound = {
    environmentId: workspace.environmentId,
    cwd: normalizeWorkspacePath(workspace.cwd),
  }
  session.workspace = bound

  const from = locationFor(sessionId)
  const newKey = computeProjectKey(bound)
  const to: SessionLocation = {
    projectKey: newKey,
    agentHome: from.agentHome,
  }
  if (from.projectKey !== to.projectKey) {
    relocateSessionFiles(sessionId, from, to)
    upsertSessionIndexEntry(
      sessionId,
      {
        projectKey: to.projectKey,
        createdAt: session.createdAt,
        ownerEmail: session.ownerEmail,
      },
      to.agentHome,
    )
  }

  appendLine(sessionId, {
    type: 'workspace_bound',
    workspace: session.workspace,
    timestamp: Date.now(),
  })
}

/**
 * Bytes of jsonl to skim for list rows. Full restoreFromDisk would JSON.parse
 * every line (including base64 image buffers) and pin the Session in RAM —
 * super's GET /sessions was doing that for every tenant transcript.
 */
const LIST_JSONL_HEAD_BYTES = 64 * 1024

function isExternalMode(value: unknown): value is ExternalMode {
  return value === 'agent' || value === 'ask' || value === 'plan'
}

function modeFromIndexLine(
  line: Record<string, unknown>,
): ExternalMode | undefined {
  const pm = line.permissionMode
  if (isExternalMode(pm)) return pm
  if (
    pm &&
    typeof pm === 'object' &&
    isExternalMode((pm as { mode?: unknown }).mode)
  ) {
    return (pm as { mode: ExternalMode }).mode
  }
  return undefined
}

function previewFromUserContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? text.slice(0, 80) : undefined
  }
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(
      (p): p is { type: string; text?: string } =>
        Boolean(p) &&
        typeof p === 'object' &&
        (p as { type?: unknown }).type === 'text',
    )
    .map(p => p.text ?? '')
    .join('')
    .trim()
  return text ? text.slice(0, 80) : undefined
}

function applyJsonlHeadToListInfo(
  info: SessionInfo,
  lines: string[],
  wholeFile: boolean,
): void {
  let messageCount = 0
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let line: Record<string, unknown>
    try {
      line = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (line.type === 'session_created') {
      if (typeof line.createdAt === 'number') info.createdAt = line.createdAt
      if (typeof line.ownerEmail === 'string') info.ownerEmail = line.ownerEmail
      const mode = modeFromIndexLine(line)
      if (mode) info.permissionMode = mode
      if (line.agentType === null || typeof line.agentType === 'string') {
        info.agentType = line.agentType
      }
    } else if (line.type === 'session_title') {
      if (typeof line.title === 'string' && line.title.trim()) {
        info.preview = line.title.trim()
      }
    } else if (line.type === 'mode_changed' || line.type === 'agent_changed') {
      const mode = modeFromIndexLine(line)
      if (mode) info.permissionMode = mode
      if (line.agentType === null || typeof line.agentType === 'string') {
        info.agentType = line.agentType
      }
    } else if (line.type === 'message') {
      messageCount++
      if (!info.preview && line.role === 'user') {
        const preview = previewFromUserContent(line.content)
        if (preview) info.preview = preview
      }
    } else if (line.type === 'compacted' && Array.isArray(line.messages)) {
      messageCount = line.messages.length
      if (!info.preview) {
        const firstUser = line.messages.find(
          (m): m is Record<string, unknown> =>
            Boolean(m) &&
            typeof m === 'object' &&
            (m as { role?: unknown }).role === 'user',
        )
        if (firstUser) {
          const preview = previewFromUserContent(firstUser.content)
          if (preview) info.preview = preview
        }
      }
    }
  }
  // Truncated reads are a lower bound; keep a higher index cache if present.
  info.messageCount = wholeFile
    ? messageCount
    : Math.max(info.messageCount, messageCount)
}

function readSessionListMeta(
  id: string,
  entry: {
    projectKey: string
    createdAt: number
    ownerEmail?: string
    messageCount?: number
  },
  home: string,
): SessionInfo {
  const info: SessionInfo = {
    id,
    createdAt: entry.createdAt,
    messageCount:
      typeof entry.messageCount === 'number' && entry.messageCount >= 0
        ? entry.messageCount
        : 0,
    ownerEmail: entry.ownerEmail,
    agentType: null,
  }
  const filePath = getSessionJsonlPath(id, entry.projectKey, home)
  if (!fs.existsSync(filePath)) return info
  try {
    const size = fs.statSync(filePath).size
    const n = Math.min(size, LIST_JSONL_HEAD_BYTES)
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(n)
      fs.readSync(fd, buf, 0, n, 0)
      const text = buf.toString('utf8')
      const lines = text.split('\n')
      const wholeFile = size <= LIST_JSONL_HEAD_BYTES
      if (!wholeFile) lines.pop()
      applyJsonlHeadToListInfo(info, lines, wholeFile)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // Keep index fields.
  }
  return info
}

function toSessionInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    createdAt: session.createdAt,
    messageCount: session.messages.length,
    preview: extractPreview(session),
    permissionMode: session.permissionMode.mode,
    agentType: session.agentType ?? null,
    ownerEmail: session.ownerEmail,
  }
}

/**
 * List sessions. In SSO mode pass the requester's email to return only that
 * user's sessions; omit it (or run without auth) to list everything.
 *
 * Super (no owner filter) must not restoreFromDisk — that JSON.parse's every
 * tenant jsonl (hundreds of MB) on the HTTP event loop and stalls /health.
 */
export function listSessions(ownerEmail?: string): SessionInfo[] {
  const homes =
    ownerEmail !== undefined ? [resolveAgentHome()] : listSessionAgentHomes()

  const infos: SessionInfo[] = []
  for (const home of homes) {
    const index = readSessionIndex(home)
    for (const [id, entry] of Object.entries(index.sessions)) {
      if (ownerEmail !== undefined && entry.ownerEmail !== ownerEmail) continue
      registerSessionLocation(id, {
        projectKey: entry.projectKey,
        agentHome: home,
      })
      const live = sessions.get(id)
      if (live) {
        if (ownerEmail !== undefined && live.ownerEmail !== ownerEmail) continue
        infos.push(toSessionInfo(live))
        continue
      }
      infos.push(readSessionListMeta(id, entry, home))
    }
  }

  return infos.sort(
    (a: SessionInfo, b: SessionInfo) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  )
}

export function deleteSession(id: string): void {
  const loc = getCachedSessionLocation(id) ?? findSessionLocation(id)
  sessions.delete(id)

  if (loc) {
    const filePath = getSessionJsonlPath(id, loc.projectKey, loc.agentHome)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    const memoryDir = getSessionDataDir(id, loc.projectKey, loc.agentHome)
    if (fs.existsSync(memoryDir)) {
      fs.rmSync(memoryDir, { recursive: true, force: true })
    }
    const uploadsDir = getChatUploadsSessionDir(id, loc.agentHome)
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true })
    }
    removeSessionIndexEntry(id, loc.agentHome)
  }
  unregisterSessionLocation(id)
  resetSessionMemoryState(id)
  resetAutoMemoryState(id)
  resetMicroCompactState(id)
  try {
    removeTasksForSession(id)
  } catch (err) {
    console.warn(
      `[session] failed to drop scheduled tasks for ${id}: ${err instanceof Error ? err.message : err}`,
    )
  }
}

/**
 * Drop process-local state for a session without touching its files.
 * Factory reset uses this after activity has stopped and before atomically
 * replacing the whole agent home.
 */
export function forgetSession(id: string): void {
  sessions.delete(id)
  unregisterSessionLocation(id)
  resetSessionMemoryState(id)
  resetAutoMemoryState(id)
  resetMicroCompactState(id)
}

export function appendMessage(sessionId: string, message: Message): void {
  const timestamp = Date.now()
  if (isAttachmentMessage(message)) {
    const { timestamp: messageTimestamp, ...rest } = message
    appendLine(sessionId, { ...rest, messageTimestamp, timestamp })
    return
  }
  const forDisk = projectMessageForDisk(message)
  if (isCompactBoundaryMessage(forDisk)) {
    const { type: messageType, timestamp: messageTimestamp, ...rest } = forDisk
    appendLine(sessionId, {
      type: 'message',
      messageType,
      ...rest,
      messageTimestamp,
      timestamp,
    })
    return
  }
  appendLine(sessionId, { type: 'message', ...forDisk, timestamp })
}

/**
 * Compatibility helper for callers outside the turn host. New compactions are
 * ordinary append-only message/attachment rows; `compacted` is read-only
 * legacy format.
 */
export function appendCompaction(sessionId: string, messages: Message[]): void {
  for (const message of messages) appendMessage(sessionId, message)
}

export function appendModeChange(sessionId: string, session: Session): void {
  appendLine(sessionId, {
    type: 'mode_changed',
    permissionMode: session.permissionMode,
    agentType: session.agentType ?? null,
    hasExitedPlanMode: session.hasExitedPlanMode ?? false,
    needsPlanModeExitAttachment: session.needsPlanModeExitAttachment ?? false,
    timestamp: Date.now(),
  })
}

/** Persist main-thread agent profile changes. */
export function appendAgentChange(sessionId: string, session: Session): void {
  appendLine(sessionId, {
    type: 'agent_changed',
    agentType: session.agentType ?? null,
    permissionMode: session.permissionMode,
    timestamp: Date.now(),
  })
}

function appendLine(sessionId: string, data: Record<string, unknown>): void {
  const loc = locationFor(sessionId)
  ensureProjectDir(loc)
  fs.appendFileSync(
    sessionPath(sessionId),
    stringifySessionJsonLine(data) + '\n',
  )
}

function restoreFromDisk(id: string): Session {
  const raw = fs.readFileSync(sessionPath(id), 'utf-8').trim()
  const lines = raw.split('\n').map((l: string) => parseSessionJsonLine(l))

  const session: Session = {
    id,
    messages: [],
    createdAt: Date.now(),
    readFileState: new Map(),
    permissionMode: createDefaultPermissionMode(),
    additionalWorkingDirectories: [],
    agentType: null,
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
  }

  const replayed = replayTranscriptMessages(lines)
  session.messages = replayed.messages
  restoreInvokedSkillsFromMessages(session, session.messages)

  for (const line of lines) {
    if (line.type === 'session_created') {
      if (typeof line.createdAt === 'number') {
        session.createdAt = line.createdAt
      }
      if (typeof line.ownerEmail === 'string') {
        session.ownerEmail = line.ownerEmail
      }
      if (line.permissionMode) {
        session.permissionMode =
          line.permissionMode as Session['permissionMode']
      }
      if (line.agentType === null || typeof line.agentType === 'string') {
        session.agentType = line.agentType
      }
    } else if (line.type === 'mode_changed') {
      if (line.permissionMode) {
        session.permissionMode =
          line.permissionMode as Session['permissionMode']
      }
      if (line.agentType === null || typeof line.agentType === 'string') {
        session.agentType = line.agentType
      }
      if (typeof line.hasExitedPlanMode === 'boolean') {
        session.hasExitedPlanMode = line.hasExitedPlanMode
      }
      if (typeof line.needsPlanModeExitAttachment === 'boolean') {
        session.needsPlanModeExitAttachment = line.needsPlanModeExitAttachment
      }
    } else if (line.type === 'agent_changed') {
      if (line.agentType === null || typeof line.agentType === 'string') {
        session.agentType = line.agentType
      }
      if (line.permissionMode) {
        session.permissionMode =
          line.permissionMode as Session['permissionMode']
      }
    } else if (line.type === 'session_title') {
      if (typeof line.title === 'string' && line.title.trim()) {
        session.title = line.title.trim()
      }
    } else if (line.type === 'workspace_bound') {
      const w = line.workspace as
        { environmentId?: unknown; cwd?: unknown } | undefined
      if (
        w &&
        typeof w.environmentId === 'string' &&
        typeof w.cwd === 'string'
      ) {
        session.workspace = {
          environmentId: w.environmentId,
          cwd: w.cwd,
        }
      }
    }
  }

  for (const migration of replayed.migrations) {
    appendLine(id, {
      type: 'message_uuid_migrated',
      eventIndex: migration.eventIndex,
      uuid: migration.uuid,
      timestamp: Date.now(),
    })
  }

  return session
}

/** Absolute jsonl path for UI / tests (resolves via index). */
export function getSessionTranscriptPath(sessionId: string): string | null {
  const loc =
    getCachedSessionLocation(sessionId) ?? findSessionLocation(sessionId)
  if (!loc) return null
  registerSessionLocation(sessionId, loc)
  return getSessionJsonlPath(sessionId, loc.projectKey, loc.agentHome)
}

export function getSessionDataDirFor(sessionId: string): string {
  return getSessionDataDir(sessionId)
}
