/**
 * Dump-prompts.
 *
 * Incremental JSONL of the *real* API-bound request/response for each LLM
 * call in the agent loop. State machine / record types:
 *   init | system_update | message | response
 *
 * Baize calls `dumpRequest` / `dumpResponse` from `runOneStep` with the
 * post-sanitize `streamText` payload (the interception point for the
 * multi-provider AI SDK).
 *
 * Enable:  DUMP_PROMPTS=1
 * Path:    ~/.ai-agent/dump-prompts/{sessionKey}.jsonl
 * Override dir: DUMP_PROMPTS_DIR
 */

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { getUserAppDir } from '../../utils/app-dir.js'
import { isEnvTruthy } from '../../utils/env.js'

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value)
}

function jsonParse(text: string): unknown {
  return JSON.parse(text)
}

/** Gate for the dump write path. */
export function isDumpPromptsEnabled(): boolean {
  return isEnvTruthy(process.env.DUMP_PROMPTS)
}

// Cache last few API requests. Useful for local debug too.
const MAX_CACHED_REQUESTS = 5
const cachedApiRequests: Array<{ timestamp: string; request: unknown }> = []

type DumpState = {
  initialized: boolean
  messageCountSeen: number
  lastInitDataHash: string
  // Cheap proxy — skip expensive stringify+hash when shape unchanged.
  lastInitFingerprint: string
}

const dumpState = new Map<string, DumpState>()

export function getLastApiRequests(): Array<{
  timestamp: string
  request: unknown
}> {
  return [...cachedApiRequests]
}

export function clearApiRequestCache(): void {
  cachedApiRequests.length = 0
}

export function clearDumpState(agentIdOrSessionId: string): void {
  dumpState.delete(agentIdOrSessionId)
}

export function clearAllDumpState(): void {
  dumpState.clear()
}

export function addApiRequestToCache(requestData: unknown): void {
  if (!isDumpPromptsEnabled()) return
  cachedApiRequests.push({
    timestamp: new Date().toISOString(),
    request: requestData,
  })
  if (cachedApiRequests.length > MAX_CACHED_REQUESTS) {
    cachedApiRequests.shift()
  }
}

function getDumpPromptsDir(): string {
  const override = process.env.DUMP_PROMPTS_DIR?.trim()
  if (override) return override
  return join(getUserAppDir(), 'dump-prompts')
}

export function getDumpPromptsPath(agentIdOrSessionId?: string): string {
  const id = (agentIdOrSessionId && agentIdOrSessionId.trim()) || 'unknown'
  return join(getDumpPromptsDir(), `${id}.jsonl`)
}

function appendToFile(filePath: string, entries: string[]): void {
  if (entries.length === 0) return
  fs.mkdir(dirname(filePath), { recursive: true })
    .then(() => fs.appendFile(filePath, entries.join('\n') + '\n'))
    .catch(() => {})
}

function systemLen(system: unknown): number {
  if (typeof system === 'string') return system.length
  if (Array.isArray(system)) {
    return system.reduce(
      (n: number, b) => n + ((b as { text?: string }).text?.length ?? 0),
      0,
    )
  }
  return 0
}

function initFingerprint(req: Record<string, unknown>): string {
  const tools = req.tools as Array<{ name?: string }> | undefined
  const toolNames = tools?.map(t => t.name ?? '').join(',') ?? ''
  return `${req.model}|${toolNames}|${systemLen(req.system)}`
}

/**
 * Body is a JSON string of the API-bound request object.
 * Async via setImmediate from the recorder so stringify does not block TTFB.
 */
function dumpRequest(
  body: string,
  ts: string,
  state: DumpState,
  filePath: string,
): void {
  try {
    const req = jsonParse(body) as Record<string, unknown>
    addApiRequestToCache(req)

    if (!isDumpPromptsEnabled()) return
    const entries: string[] = []
    const messages = (req.messages ?? []) as Array<{ role?: string }>

    const fingerprint = initFingerprint(req)
    if (!state.initialized || fingerprint !== state.lastInitFingerprint) {
      const { messages: _omit, ...initData } = req
      const initDataStr = jsonStringify(initData)
      const initDataHash = hashString(initDataStr)
      state.lastInitFingerprint = fingerprint
      if (!state.initialized) {
        state.initialized = true
        state.lastInitDataHash = initDataHash
        entries.push(
          `{"type":"init","timestamp":"${ts}","data":${initDataStr}}`,
        )
      } else if (initDataHash !== state.lastInitDataHash) {
        state.lastInitDataHash = initDataHash
        entries.push(
          `{"type":"system_update","timestamp":"${ts}","data":${initDataStr}}`,
        )
      }
    }

    // Only new user messages (assistant captured in response).
    // Baize AI SDK also places tool results on role:"tool" — include those
    // so tool trajectory is visible in the same incremental stream.
    for (const msg of messages.slice(state.messageCountSeen)) {
      if (msg.role === 'user' || msg.role === 'tool') {
        entries.push(
          jsonStringify({ type: 'message', timestamp: ts, data: msg }),
        )
      }
    }
    state.messageCountSeen = messages.length

    appendToFile(filePath, entries)
  } catch {
    // Ignore parsing errors — dump must never break the agent.
  }
}

function dumpResponseToFile(
  filePath: string,
  timestamp: string,
  data: unknown,
): void {
  if (!isDumpPromptsEnabled()) return
  fs.mkdir(dirname(filePath), { recursive: true })
    .then(() =>
      fs.appendFile(
        filePath,
        jsonStringify({ type: 'response', timestamp, data }) + '\n',
      ),
    )
    .catch(() => {})
}

/** Shape passed into dump (the POST JSON body fields we care about). */
export type ApiRequestLike = {
  model: string
  system: string | unknown[]
  messages: unknown[]
  tools?: Array<{ name?: string; [k: string]: unknown }>
  [k: string]: unknown
}

export type DumpPromptsRecorder = {
  /** Fire-and-forget; defers the write via setImmediate. */
  dumpRequest: (req: ApiRequestLike) => string
  dumpResponse: (timestamp: string, data: unknown) => void
  path: string
  sessionKey: string
}

const announced = new Set<string>()

/**
 * One recorder per query/agent run.
 * Call once in `runAgent`, reuse across steps (preserves DumpState).
 */
export function createDumpPromptsRecorder(
  agentIdOrSessionId: string,
): DumpPromptsRecorder {
  const sessionKey = agentIdOrSessionId || 'unknown'
  const filePath = getDumpPromptsPath(sessionKey)

  if (isDumpPromptsEnabled() && !announced.has(filePath)) {
    announced.add(filePath)
    console.log(`[dump-prompts] writing → ${filePath}`)
  }

  return {
    sessionKey,
    path: filePath,
    dumpRequest(req: ApiRequestLike): string {
      const timestamp = new Date().toISOString()
      if (!isDumpPromptsEnabled()) return timestamp

      const state = dumpState.get(sessionKey) ?? {
        initialized: false,
        messageCountSeen: 0,
        lastInitDataHash: '',
        lastInitFingerprint: '',
      }
      dumpState.set(sessionKey, state)

      const body = jsonStringify(req)
      // Parsing + stringifying can take hundreds of ms — defer.
      setImmediate(dumpRequest, body, timestamp, state, filePath)
      return timestamp
    },
    dumpResponse(timestamp: string, data: unknown): void {
      if (!isDumpPromptsEnabled()) return
      void dumpResponseToFile(filePath, timestamp, data)
    },
  }
}

/** No-op recorder when dump is disabled — keeps call sites branch-free. */
export function createNoopDumpPromptsRecorder(): DumpPromptsRecorder {
  return {
    sessionKey: '',
    path: '',
    dumpRequest: () => new Date().toISOString(),
    dumpResponse: () => {},
  }
}

/**
 * Summarize AI SDK tool map for init (name + description + parameters when present).
 */
export function toolsForDump(
  apiTools: Record<
    string,
    { description?: string; parameters?: unknown; inputSchema?: unknown }
  >,
): Array<{ name: string; description?: string; parameters?: unknown }> {
  return Object.entries(apiTools).map(([name, t]) => ({
    name,
    ...(typeof t.description === 'string'
      ? { description: t.description }
      : {}),
    ...(t.parameters != null
      ? { parameters: t.parameters }
      : t.inputSchema != null
        ? { parameters: t.inputSchema }
        : {}),
  }))
}
