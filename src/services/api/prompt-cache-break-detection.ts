/**
 * Explains prompt cache misses. Before each request the system prompt, tool
 * schemas, model and conversation prefix are fingerprinted; after it, a drop
 * in cache-read tokens is matched against what changed since the previous
 * request of the same agent.
 *
 * A drop is not reported when the conversation itself was rewritten
 * (compaction, cleared tool results): that loss is expected.
 */
import { createHash } from 'node:crypto'
import { asSchema } from 'ai'

/** Drops smaller than this are normal variation. */
const MIN_CACHE_MISS_TOKENS = 2_000
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
/** Subagents each get their own entry; keep the map from growing without bound. */
const MAX_TRACKED_AGENTS = 10

type ToolLike = { description?: string; inputSchema?: unknown }

export interface PromptStateSnapshot {
  /** Session plus agent; requests with different keys never share a cache. */
  key: string
  system: string
  tools: Record<string, ToolLike>
  model: string
  messages: readonly unknown[]
}

export interface CacheBreak {
  reason: string
  previousCacheReadTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface PendingChanges {
  modelChanged: boolean
  previousModel: string
  systemPromptChanged: boolean
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
}

interface TrackedState {
  systemHash: string
  systemChars: number
  toolHashes: Map<string, string>
  model: string
  messageHashes: string[]
  historyRewritten: boolean
  pending: PendingChanges | null
  prevCacheReadTokens: number | null
  lastResponseAt: number | null
}

const states = new Map<string, TrackedState>()
const schemaHashes = new WeakMap<object, string>()
const messageHashCache = new WeakMap<object, string>()

function hash(value: string): string {
  return createHash('sha1').update(value).digest('base64')
}

function toolHash(tool: ToolLike): string {
  const schema = tool.inputSchema
  let schemaHash = ''
  if (schema && typeof schema === 'object') {
    const cached = schemaHashes.get(schema)
    if (cached !== undefined) {
      schemaHash = cached
    } else {
      try {
        schemaHash = hash(JSON.stringify(asSchema(schema as never).jsonSchema))
      } catch {
        schemaHash = 'unserializable'
      }
      schemaHashes.set(schema, schemaHash)
    }
  }
  return hash(`${tool.description ?? ''}\n${schemaHash}`)
}

function messageHash(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return hash(JSON.stringify(message ?? null))
  }
  const cached = messageHashCache.get(message)
  if (cached !== undefined) return cached
  const value = hash(JSON.stringify(message))
  messageHashCache.set(message, value)
  return value
}

/** Before a request: record what it sends and what changed since the last one. */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  const systemHash = hash(snapshot.system)
  const toolHashes = new Map(
    Object.entries(snapshot.tools).map(([name, t]) => [name, toolHash(t)]),
  )
  const messageHashes = snapshot.messages.map(messageHash)
  const prev = states.get(snapshot.key)

  if (!prev) {
    while (states.size >= MAX_TRACKED_AGENTS) {
      const oldest = states.keys().next().value
      if (oldest === undefined) break
      states.delete(oldest)
    }
    states.set(snapshot.key, {
      systemHash,
      systemChars: snapshot.system.length,
      toolHashes,
      model: snapshot.model,
      messageHashes,
      historyRewritten: false,
      pending: null,
      prevCacheReadTokens: null,
      lastResponseAt: null,
    })
    return
  }

  const historyRewritten =
    messageHashes.length < prev.messageHashes.length ||
    prev.messageHashes.some((h, i) => messageHashes[i] !== h)

  const addedTools: string[] = []
  const changedToolSchemas: string[] = []
  for (const [name, h] of toolHashes) {
    const before = prev.toolHashes.get(name)
    if (before === undefined) addedTools.push(name)
    else if (before !== h) changedToolSchemas.push(name)
  }
  const removedTools = [...prev.toolHashes.keys()].filter(
    name => !toolHashes.has(name),
  )
  const modelChanged = snapshot.model !== prev.model
  const systemPromptChanged = systemHash !== prev.systemHash
  const toolsChanged =
    addedTools.length + removedTools.length + changedToolSchemas.length > 0

  // A retried request records again before any response; keep what the
  // failed attempt saw until a response consumes it.
  if (modelChanged || systemPromptChanged || toolsChanged) {
    prev.pending = {
      modelChanged,
      previousModel: prev.model,
      systemPromptChanged,
      systemCharDelta: snapshot.system.length - prev.systemChars,
      addedTools,
      removedTools,
      changedToolSchemas,
    }
  }
  prev.historyRewritten ||= historyRewritten
  prev.systemHash = systemHash
  prev.systemChars = snapshot.system.length
  prev.toolHashes = toolHashes
  prev.model = snapshot.model
  prev.messageHashes = messageHashes
}

function describeChanges(c: PendingChanges, model: string): string[] {
  const parts: string[] = []
  if (c.modelChanged)
    parts.push(`model changed (${c.previousModel} → ${model})`)
  if (c.systemPromptChanged) {
    const delta = c.systemCharDelta
    parts.push(
      `system prompt changed${delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta} chars)`}`,
    )
  }
  if (c.addedTools.length || c.removedTools.length) {
    const added = c.addedTools.map(n => `+${n}`)
    const removed = c.removedTools.map(n => `-${n}`)
    parts.push(`tools changed (${[...added, ...removed].join(', ')})`)
  }
  if (c.changedToolSchemas.length) {
    parts.push(`tool schemas changed (${c.changedToolSchemas.join(', ')})`)
  }
  return parts
}

/**
 * After a response: report a cache break when cache reads fell by more than
 * 5% and at least {@link MIN_CACHE_MISS_TOKENS} since the previous request.
 */
export function checkResponseForCacheBreak(
  key: string,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  now = Date.now(),
): CacheBreak | null {
  const state = states.get(key)
  if (!state) return null
  const prevRead = state.prevCacheReadTokens
  const gapMs =
    state.lastResponseAt === null ? null : now - state.lastResponseAt
  const pending = state.pending
  const historyRewritten = state.historyRewritten
  state.prevCacheReadTokens = cacheReadTokens
  state.lastResponseAt = now
  state.pending = null
  state.historyRewritten = false

  if (prevRead === null || historyRewritten) return null
  const drop = prevRead - cacheReadTokens
  if (cacheReadTokens >= prevRead * 0.95 || drop < MIN_CACHE_MISS_TOKENS) {
    return null
  }

  const parts = pending ? describeChanges(pending, state.model) : []
  let reason: string
  if (parts.length > 0) reason = parts.join(', ')
  else if (gapMs !== null && gapMs > CACHE_TTL_1HOUR_MS)
    reason = 'possible 1h TTL expiry (prompt unchanged)'
  else if (gapMs !== null && gapMs > CACHE_TTL_5MIN_MS)
    reason = 'possible 5min TTL expiry (prompt unchanged)'
  else reason = 'likely server-side (prompt unchanged, <5min gap)'

  return {
    reason,
    previousCacheReadTokens: prevRead,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

export function resetPromptCacheBreakDetection(): void {
  states.clear()
}
