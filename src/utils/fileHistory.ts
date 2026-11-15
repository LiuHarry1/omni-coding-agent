/**
 * File history for rewind: the edit and write tools back up a file before
 * they first change it in a turn, and every user message opens a snapshot
 * those backups go into. Rewinding to a message puts each file changed since
 * back the way it was when that message was sent. Local workspaces only.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getSessionDataDir } from '../session/paths.js'

export const MAX_SNAPSHOTS = 100

interface Snapshot {
  messageUuid: string
  timestamp: number
  /** Absolute path → backup file name, or null when the file did not exist. */
  backups: Record<string, string | null>
}

interface HistoryState {
  snapshots: Snapshot[]
}

export interface RewindResult {
  restored: string[]
  deleted: string[]
}

function historyDir(sessionId: string): string | null {
  try {
    return path.join(getSessionDataDir(sessionId), 'file-history')
  } catch {
    return null
  }
}

function readState(dir: string): HistoryState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, 'index.json'), 'utf8'),
    ) as HistoryState
    if (Array.isArray(parsed.snapshots)) return parsed
  } catch {
    // No history yet, or an unreadable one: start over.
  }
  return { snapshots: [] }
}

function writeState(dir: string, state: HistoryState): void {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'index.json')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

function backupName(abs: string, snapshotIndex: number, ts: number): string {
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 16)
  return `${hash}@${ts}-${snapshotIndex}`
}

/** Open a snapshot for the turn `messageUuid` starts. */
export function fileHistoryMakeSnapshot(
  sessionId: string,
  messageUuid: string,
): void {
  const dir = historyDir(sessionId)
  if (!dir) return
  const state = readState(dir)
  if (state.snapshots.at(-1)?.messageUuid === messageUuid) return
  state.snapshots.push({ messageUuid, timestamp: Date.now(), backups: {} })
  const dropped = state.snapshots.splice(
    0,
    Math.max(0, state.snapshots.length - MAX_SNAPSHOTS),
  )
  writeState(dir, state)
  removeBackupsOf(dir, state, dropped)
}

/** Delete the backups of `dropped` that no snapshot left in `state` uses. */
function removeBackupsOf(
  dir: string,
  state: HistoryState,
  dropped: Snapshot[],
): void {
  const live = new Set(
    state.snapshots.flatMap(s => Object.values(s.backups)).filter(Boolean),
  )
  for (const snap of dropped) {
    for (const name of Object.values(snap.backups)) {
      if (name && !live.has(name))
        fs.rmSync(path.join(dir, name), { force: true })
    }
  }
}

/**
 * Back up `abs` before a tool changes it, once per snapshot. Does nothing
 * before the session's first snapshot.
 */
export function fileHistoryTrackEdit(
  sessionId: string | undefined,
  abs: string,
): void {
  if (!sessionId) return
  const dir = historyDir(sessionId)
  if (!dir) return
  const state = readState(dir)
  const index = state.snapshots.length - 1
  const current = state.snapshots[index]
  if (!current || abs in current.backups) return
  let name: string | null = null
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    name = backupName(abs, index, current.timestamp)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(abs, path.join(dir, name))
  }
  current.backups[abs] = name
  writeState(dir, state)
}

/** Files changed since `messageUuid` was sent, with their content then. */
function changesSince(
  dir: string,
  state: HistoryState,
  messageUuid: string,
): Map<string, string | null> | null {
  const start = state.snapshots.findIndex(s => s.messageUuid === messageUuid)
  if (start < 0) return null
  const earliest = new Map<string, string | null>()
  for (const snap of state.snapshots.slice(start)) {
    for (const [abs, name] of Object.entries(snap.backups)) {
      if (!earliest.has(abs)) earliest.set(abs, name)
    }
  }
  for (const name of earliest.values()) {
    if (name && !fs.existsSync(path.join(dir, name))) return null
  }
  return earliest
}

export function fileHistoryCanRestore(
  sessionId: string,
  messageUuid: string,
): boolean {
  const dir = historyDir(sessionId)
  return !!dir && changesSince(dir, readState(dir), messageUuid) !== null
}

/** Paths a rewind to `messageUuid` would put back. */
export function fileHistoryChangedFiles(
  sessionId: string,
  messageUuid: string,
): string[] {
  const dir = historyDir(sessionId)
  if (!dir) return []
  return [...(changesSince(dir, readState(dir), messageUuid)?.keys() ?? [])]
}

/**
 * Of those, the files that did not exist when `messageUuid` was sent and do
 * now: a rewind deletes them.
 */
export function fileHistoryCreatedFiles(
  sessionId: string,
  messageUuid: string,
): string[] {
  const dir = historyDir(sessionId)
  if (!dir) return []
  const changes = changesSince(dir, readState(dir), messageUuid)
  return [...(changes ?? [])]
    .filter(([abs, name]) => name === null && fs.existsSync(abs))
    .map(([abs]) => abs)
}

/**
 * Put every file changed since `messageUuid` back, and drop the snapshots
 * from that message on: the rewound turns no longer exist.
 */
export function fileHistoryRewind(
  sessionId: string,
  messageUuid: string,
): RewindResult {
  const dir = historyDir(sessionId)
  if (!dir) throw new Error('no file history for this session')
  const state = readState(dir)
  const changes = changesSince(dir, state, messageUuid)
  if (!changes) throw new Error('no file snapshot for this message')
  const result: RewindResult = { restored: [], deleted: [] }
  for (const [abs, name] of changes) {
    if (name === null) {
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true })
        result.deleted.push(abs)
      }
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(path.join(dir, name), abs)
    result.restored.push(abs)
  }
  const start = state.snapshots.findIndex(s => s.messageUuid === messageUuid)
  const dropped = state.snapshots.splice(start)
  writeState(dir, state)
  removeBackupsOf(dir, state, dropped)
  return result
}

/** Give a forked session the snapshots taken before `beforeMessageUuid`. */
export function fileHistoryCopy(
  fromSessionId: string,
  toSessionId: string,
  beforeMessageUuid?: string,
): void {
  const from = historyDir(fromSessionId)
  const to = historyDir(toSessionId)
  if (!from || !to) return
  const state = readState(from)
  let snapshots = state.snapshots
  if (beforeMessageUuid) {
    const end = snapshots.findIndex(s => s.messageUuid === beforeMessageUuid)
    if (end >= 0) snapshots = snapshots.slice(0, end)
  }
  if (snapshots.length === 0) return
  fs.mkdirSync(to, { recursive: true })
  for (const snap of snapshots) {
    for (const name of Object.values(snap.backups)) {
      const src = name && path.join(from, name)
      if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(to, name))
    }
  }
  writeState(to, { snapshots })
}
