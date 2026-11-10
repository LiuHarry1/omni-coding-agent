/**
 * Per-agentHome session index: id → { projectKey, createdAt, ownerEmail? }
 * Lives at `{agentHome}/.ai-agent/session-index.json`.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  getSessionIndexPath,
  type SessionLocation,
} from '../core/session-paths.js'
import { getAppDirName } from '../utils/app-dir.js'
import { resolveAgentHome } from '../utils/request-scope.js'

export type SessionIndexEntry = {
  projectKey: string
  createdAt: number
  ownerEmail?: string
  /** Optional list-row cache; GET /sessions must not restore jsonl to fill these. */
  preview?: string
  messageCount?: number
  permissionMode?: string
  agentType?: string | null
}

export type SessionIndexFile = {
  version: 1
  sessions: Record<string, SessionIndexEntry>
}

function emptyIndex(): SessionIndexFile {
  return { version: 1, sessions: {} }
}

function readFirstJsonlLine(filePath: string): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytes).toString('utf8').split('\n')[0] ?? ''
  } finally {
    fs.closeSync(fd)
  }
}

function rebuildSessionIndex(agentHome: string): SessionIndexFile {
  const rebuilt = emptyIndex()
  const projectsRoot = path.join(agentHome, getAppDirName(), 'projects')
  let projectKeys: string[] = []
  try {
    projectKeys = fs.readdirSync(projectsRoot)
  } catch {
    return rebuilt
  }
  for (const projectKey of projectKeys) {
    const projectDir = path.join(projectsRoot, projectKey)
    let names: string[] = []
    try {
      names = fs.readdirSync(projectDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const transcript = path.join(projectDir, name)
      try {
        const firstLine = readFirstJsonlLine(transcript)
        const created = JSON.parse(firstLine) as Record<string, unknown>
        const stat = fs.statSync(transcript)
        rebuilt.sessions[sessionId] = {
          projectKey,
          createdAt:
            typeof created.createdAt === 'number'
              ? created.createdAt
              : stat.birthtimeMs || stat.mtimeMs,
          ...(typeof created.ownerEmail === 'string'
            ? { ownerEmail: created.ownerEmail }
            : {}),
        }
      } catch (error) {
        console.warn(
          `[session-index] cannot rebuild ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  return rebuilt
}

function recoverSessionIndex(
  filePath: string,
  agentHome: string,
  reason: string,
): SessionIndexFile {
  const backup = `${filePath}.corrupt.${Date.now()}`
  try {
    fs.renameSync(filePath, backup)
  } catch {
    // Preserve the original when backup is not possible.
  }
  const rebuilt = rebuildSessionIndex(agentHome)
  writeSessionIndex(rebuilt, agentHome)
  console.warn(
    `[session-index] recovered ${Object.keys(rebuilt.sessions).length} session(s) ` +
      `after ${reason}; corrupt index backed up to ${backup}`,
  )
  return rebuilt
}

export function readSessionIndex(agentHome?: string): SessionIndexFile {
  const home = resolveAgentHome(agentHome)
  const filePath = getSessionIndexPath(home)
  if (!fs.existsSync(filePath)) return emptyIndex()
  try {
    const raw = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as SessionIndexFile
    if (!raw || raw.version !== 1 || typeof raw.sessions !== 'object') {
      return recoverSessionIndex(filePath, home, 'invalid schema')
    }
    return raw
  } catch (error) {
    return recoverSessionIndex(
      filePath,
      home,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export function writeSessionIndex(
  index: SessionIndexFile,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const filePath = getSessionIndexPath(home)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const body = JSON.stringify(index, null, 2) + '\n'
  fs.writeFileSync(tmp, body, 'utf-8')
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    fs.rmSync(filePath, { force: true })
    fs.renameSync(tmp, filePath)
  }
}

export function upsertSessionIndexEntry(
  sessionId: string,
  entry: SessionIndexEntry,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const index = readSessionIndex(home)
  index.sessions[sessionId] = entry
  writeSessionIndex(index, home)
}

export function removeSessionIndexEntry(
  sessionId: string,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const index = readSessionIndex(home)
  if (!(sessionId in index.sessions)) return
  delete index.sessions[sessionId]
  writeSessionIndex(index, home)
}

export function lookupSessionIndexEntry(
  sessionId: string,
  agentHome?: string,
): SessionIndexEntry | null {
  const entry = readSessionIndex(agentHome).sessions[sessionId]
  return entry ?? null
}

export function entryToLocation(
  entry: SessionIndexEntry,
  agentHome: string,
): SessionLocation {
  return { projectKey: entry.projectKey, agentHome: path.resolve(agentHome) }
}

/**
 * List agent homes that may hold session indexes.
 * AUTH off: current/os home. AUTH on: USERS_ROOT/* (and current ALS home).
 */
export function listSessionAgentHomes(): string[] {
  const homes = new Set<string>()
  homes.add(resolveAgentHome())

  const authOn =
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  if (authOn) {
    const usersRoot = process.env.USERS_ROOT?.trim()
    if (usersRoot) {
      const root = path.resolve(usersRoot)
      try {
        for (const name of fs.readdirSync(root)) {
          const dir = path.join(root, name)
          try {
            if (!fs.statSync(dir).isDirectory()) continue
          } catch {
            continue
          }
          const idx = path.join(dir, getAppDirName(), 'session-index.json')
          if (fs.existsSync(idx)) homes.add(dir)
          else {
            const projects = path.join(dir, getAppDirName(), 'projects')
            if (fs.existsSync(projects)) homes.add(dir)
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return [...homes]
}

/** Find session id across known agent homes. */
export function findSessionLocation(
  sessionId: string,
  preferredHome?: string,
): SessionLocation | null {
  if (preferredHome) {
    const entry = lookupSessionIndexEntry(sessionId, preferredHome)
    if (entry) return entryToLocation(entry, preferredHome)
  }
  const current = resolveAgentHome()
  const entry = lookupSessionIndexEntry(sessionId, current)
  if (entry) return entryToLocation(entry, current)

  for (const home of listSessionAgentHomes()) {
    if (path.resolve(home) === path.resolve(current)) continue
    if (preferredHome && path.resolve(home) === path.resolve(preferredHome)) {
      continue
    }
    const e = lookupSessionIndexEntry(sessionId, home)
    if (e) return entryToLocation(e, home)
  }
  return null
}
