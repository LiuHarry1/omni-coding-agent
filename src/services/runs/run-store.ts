import * as fs from 'fs'
import * as path from 'path'
import { getSessionDataDir } from '../../core/session-paths.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { resolveAgentHome } from '../../utils/request-scope.js'
import {
  listSessionAgentHomes,
  readSessionIndex,
} from '../../session/session-index.js'
import type { DurableRunState, StoredRunEvent } from './types.js'
import { isTerminalRunStatus } from './types.js'

type RunIndexEntry = {
  sessionId: string
  createdAt: number
}

type RunIndex = {
  version: 1
  runs: Record<string, RunIndexEntry>
  activeBySession: Record<string, string>
}

function emptyRunIndex(): RunIndex {
  return { version: 1, runs: {}, activeBySession: {} }
}

const calibratedHomes = new Set<string>()

function runIndexPath(agentHome?: string): string {
  return path.join(
    resolveAgentHome(agentHome),
    getAppDirName(),
    'run-index.json',
  )
}

function readRunIndex(agentHome?: string): RunIndex {
  const home = resolveAgentHome(agentHome)
  const filePath = runIndexPath(agentHome)
  if (!fs.existsSync(filePath)) return emptyRunIndex()
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<RunIndex>
    if (
      parsed?.version !== 1 ||
      !parsed.runs ||
      typeof parsed.runs !== 'object' ||
      Array.isArray(parsed.runs)
    ) {
      return emptyRunIndex()
    }
    const index: RunIndex = {
      version: 1,
      runs: parsed.runs,
      activeBySession:
        parsed.activeBySession &&
        typeof parsed.activeBySession === 'object' &&
        !Array.isArray(parsed.activeBySession)
          ? parsed.activeBySession
          : {},
    }
    if (!parsed.activeBySession) {
      rebuildActivePointers(index, home)
      writeRunIndex(index, home)
      calibratedHomes.add(path.resolve(home))
    }
    return index
  } catch {
    return emptyRunIndex()
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    fs.rmSync(filePath, { force: true })
    fs.renameSync(tmp, filePath)
  }
}

function writeRunIndex(index: RunIndex, agentHome?: string): void {
  atomicWriteJson(runIndexPath(agentHome), index)
}

function runDirFromSession(
  sessionId: string,
  runId: string,
  agentHome?: string,
): string | null {
  const home = resolveAgentHome(agentHome)
  const sessionEntry = readSessionIndex(home).sessions[sessionId]
  if (!sessionEntry) return null
  return path.join(
    getSessionDataDir(sessionId, sessionEntry.projectKey, home),
    'runs',
    runId,
  )
}

function runDirForState(state: DurableRunState): string {
  const dir = runDirFromSession(state.sessionId, state.runId, state.agentHome)
  if (!dir) {
    throw new Error(`Session not indexed for run ${state.runId}`)
  }
  return dir
}

function readIndexedState(
  runId: string,
  entry: RunIndexEntry,
  agentHome: string,
): DurableRunState | null {
  const dir = runDirFromSession(entry.sessionId, runId, agentHome)
  if (!dir) return null
  const filePath = path.join(dir, 'state.json')
  if (!fs.existsSync(filePath)) return null
  try {
    const state = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as DurableRunState
    if (
      state?.version !== 1 ||
      state.runId !== runId ||
      state.sessionId !== entry.sessionId
    ) {
      return null
    }
    return state
  } catch {
    return null
  }
}

function rebuildActivePointers(index: RunIndex, agentHome: string): void {
  const latest = new Map<string, DurableRunState>()
  for (const [runId, entry] of Object.entries(index.runs)) {
    const state = readIndexedState(runId, entry, agentHome)
    if (!state || isTerminalRunStatus(state.status)) continue
    const current = latest.get(state.sessionId)
    if (
      !current ||
      state.createdAt > current.createdAt ||
      (state.createdAt === current.createdAt &&
        state.runId.localeCompare(current.runId) > 0)
    ) {
      latest.set(state.sessionId, state)
    }
  }
  index.activeBySession = Object.fromEntries(
    [...latest].map(([sessionId, state]) => [sessionId, state.runId]),
  )
}

/** Startup/lazy repair for old, missing, or stale active pointers. */
export function calibrateActiveRunPointers(agentHome?: string): void {
  const home = resolveAgentHome(agentHome)
  const index = readRunIndex(home)
  const before = JSON.stringify(index.activeBySession)
  rebuildActivePointers(index, home)
  if (JSON.stringify(index.activeBySession) !== before) {
    writeRunIndex(index, home)
  }
  calibratedHomes.add(path.resolve(home))
}

function statePathForState(state: DurableRunState): string {
  return path.join(runDirForState(state), 'state.json')
}

function eventsPathForState(state: DurableRunState): string {
  return path.join(runDirForState(state), 'events.jsonl')
}

export function createRunState(state: DurableRunState): void {
  const index = readRunIndex(state.agentHome)
  index.runs[state.runId] = {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
  }
  if (!isTerminalRunStatus(state.status)) {
    index.activeBySession[state.sessionId] = state.runId
  }
  writeRunIndex(index, state.agentHome)
  writeRunState(state)
}

export function writeRunState(state: DurableRunState): void {
  atomicWriteJson(statePathForState(state), state)
  const index = readRunIndex(state.agentHome)
  let changed = false
  if (isTerminalRunStatus(state.status)) {
    if (index.activeBySession[state.sessionId] === state.runId) {
      delete index.activeBySession[state.sessionId]
      changed = true
    }
  } else if (!index.activeBySession[state.sessionId]) {
    index.activeBySession[state.sessionId] = state.runId
    changed = true
  }
  if (changed) writeRunIndex(index, state.agentHome)
}

function readLastEventSeq(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    if (size === 0) return 0

    let windowBytes = Math.min(size, 4 * 1024)
    for (;;) {
      const start = size - windowBytes
      const prefixBytes = start > 0 ? 1 : 0
      const buffer = Buffer.allocUnsafe(windowBytes + prefixBytes)
      const bytesRead = fs.readSync(
        fd,
        buffer,
        0,
        buffer.length,
        start - prefixBytes,
      )
      const startsOnRowBoundary =
        start === 0 || (bytesRead > 0 && buffer[0] === 0x0a)
      const text = buffer.subarray(prefixBytes, bytesRead).toString('utf8')
      const lines = text.split('\n')

      // A non-zero start can land in the middle of a large JSON row.
      if (!startsOnRowBoundary) lines.shift()
      // appendRunEvent always newline-terminates committed rows. A final
      // fragment without one is torn and must never advance lastSeq.
      if (!text.endsWith('\n')) lines.pop()

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim()
        if (!line) continue
        try {
          const event = JSON.parse(line) as Partial<StoredRunEvent>
          if (typeof event.seq === 'number') return event.seq
        } catch {
          // Skip corrupt rows and continue toward the previous committed row.
        }
      }

      if (start === 0) return 0
      windowBytes = Math.min(size, windowBytes * 2)
    }
  } catch {
    // Missing/unreadable event logs are treated as empty.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
  return 0
}

export function readRunState(
  runId: string,
  agentHome?: string,
): DurableRunState | null {
  const home = resolveAgentHome(agentHome)
  const entry = readRunIndex(home).runs[runId]
  if (!entry) return null
  const state = readIndexedState(runId, entry, home)
  if (!state) return null
  const dir = runDirFromSession(entry.sessionId, runId, home)
  if (!dir) return null
  state.lastSeq = Math.max(
    state.lastSeq ?? 0,
    readLastEventSeq(path.join(dir, 'events.jsonl')),
  )
  return state
}

/** Resolve an opaque run id across tenant homes; authorization stays in HTTP. */
export function findRunState(
  runId: string,
  preferredHome?: string,
): DurableRunState | null {
  const preferred = resolveAgentHome(preferredHome)
  const first = readRunState(runId, preferred)
  if (first) return first
  for (const home of listSessionAgentHomes()) {
    if (path.resolve(home) === path.resolve(preferred)) continue
    const state = readRunState(runId, home)
    if (state) return state
  }
  return null
}

export function appendRunEvent(
  state: DurableRunState,
  event: StoredRunEvent,
): void {
  const filePath = eventsPathForState(state)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8')
}

export function readRunEvents(
  state: DurableRunState,
  afterSeq = 0,
): StoredRunEvent[] {
  const filePath = eventsPathForState(state)
  if (!fs.existsSync(filePath)) return []
  const events: StoredRunEvent[] = []
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as StoredRunEvent
      if (
        event?.version === 1 &&
        event.runId === state.runId &&
        typeof event.seq === 'number' &&
        event.seq > afterSeq
      ) {
        events.push(event)
      }
    } catch {
      // Ignore torn/corrupt rows; transcript and run state remain canonical.
    }
  }
  return events.sort((a, b) => a.seq - b.seq)
}

export function listRunStates(
  agentHome?: string,
  opts: { nonTerminalOnly?: boolean } = {},
): DurableRunState[] {
  const home = resolveAgentHome(agentHome)
  const states: DurableRunState[] = []
  for (const runId of Object.keys(readRunIndex(home).runs)) {
    const state = readRunState(runId, home)
    if (!state) continue
    if (opts.nonTerminalOnly && isTerminalRunStatus(state.status)) continue
    states.push(state)
  }
  return states.sort((a, b) => a.createdAt - b.createdAt)
}

export function findActiveRunStateForSession(
  sessionId: string,
  preferredHome?: string,
): DurableRunState | null {
  const preferred = resolveAgentHome(preferredHome)
  const homes =
    preferredHome !== undefined
      ? [preferred]
      : [
          preferred,
          ...listSessionAgentHomes().filter(
            home => path.resolve(home) !== path.resolve(preferred),
          ),
        ]
  const candidates: DurableRunState[] = []
  for (const home of homes) {
    let index = readRunIndex(home)
    let runId = index.activeBySession[sessionId]
    let state = runId ? readRunState(runId, home) : null
    const pointerValid =
      state != null &&
      state.sessionId === sessionId &&
      !isTerminalRunStatus(state.status)

    if (
      !pointerValid &&
      (runId != null || !calibratedHomes.has(path.resolve(home)))
    ) {
      calibrateActiveRunPointers(home)
      index = readRunIndex(home)
      runId = index.activeBySession[sessionId]
      state = runId ? readRunState(runId, home) : null
    }
    if (
      state &&
      state.sessionId === sessionId &&
      !isTerminalRunStatus(state.status)
    ) {
      candidates.push(state)
    }
  }
  return (
    candidates.sort(
      (a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId),
    )[0] ?? null
  )
}

export function removeRunsForSession(
  sessionId: string,
  agentHome?: string,
): void {
  const home = resolveAgentHome(agentHome)
  const index = readRunIndex(home)
  let changed = false
  for (const [runId, entry] of Object.entries(index.runs)) {
    if (entry.sessionId !== sessionId) continue
    delete index.runs[runId]
    changed = true
  }
  if (index.activeBySession[sessionId] !== undefined) {
    delete index.activeBySession[sessionId]
    changed = true
  }
  if (changed) writeRunIndex(index, home)
}
