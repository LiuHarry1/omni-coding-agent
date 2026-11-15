/**
 * Non-blocking relevant-memory prefetch.
 */
import type {
  AttachmentMessage,
  AgentDefinition,
  Message,
  ToolUseContext,
  AutoMemoryConfig,
} from '../../core/types.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import { extractAgentMentions } from '../../utils/attachments/extract-mentions.js'
import { isAttachmentMessage, isRoleMessage } from '../../core/types.js'
import type { IProvider } from '../llm/types.js'
import type { Attachment } from '../../utils/attachments/types.js'
import type { ReadFileState } from '../../utils/read/types.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { getActiveModelMessages } from '../compact/index.js'
import {
  findFastRelevantMemories,
  findRelevantMemories,
  MAX_SESSION_BYTES,
  readMemoriesForSurfacing,
  readMemoriesForSurfacingSync,
  type SelectRelevantFn,
} from './findRelevant.js'

/**
 * @deprecated Prefer MemoryBinding.readDirs. Kept for mention-only tests:
 * when the user @-mentions a subagent with memory, search that memdir;
 * otherwise keep the caller-supplied auto-memory path.
 */
export function resolvePrefetchMemoryDirs(
  queryText: string,
  autoMemPath: string,
  agents: readonly AgentDefinition[] | undefined,
  cwd: string,
  autoMemoryEnabled: boolean,
): string[] {
  if (!autoMemoryEnabled || !agents?.length) return [autoMemPath]
  const mentions = extractAgentMentions(queryText)
  const dirs = mentions.flatMap(agentType => {
    const def = agents.find(a => a.agentType === agentType)
    if (!def?.memory || def.mode === 'primary') return []
    return [getAgentMemoryDir(agentType, def.memory, cwd)]
  })
  return dirs.length > 0 ? dirs : [autoMemPath]
}

export type MemoryPrefetch = {
  immediate: Attachment[]
  immediateStrong: boolean
  /** -1 until the deterministic lane is consumed. */
  immediateConsumedOnIteration: number
  promise: Promise<Attachment[]>
  settledAt: number | null
  /** -1 until the semantic lane is consumed. */
  consumedOnIteration: number
  dispose: () => void
}

export type MemoryRecallDecision =
  'strong-fast-hit' | 'recall' | 'no-recall-intent'

export type TimedMemoryPrefetchResult = {
  attachments: AttachmentMessage[]
  timedOut: boolean
}

export const EXPLICIT_RECALL_TIMEOUT_MS = 4_000

export const RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES,
} as const

const ENGLISH_RECALL_PATTERNS = [
  /\b(?:previously|earlier|last time|used to)\b/iu,
  /\b(?:do|can|could|would)\s+you\s+(?:remember|recall)\b/iu,
  /\b(?:remember|recall)\s+(?:when|what|which|who|where|why|how)\b/iu,
  /\b(?:we|you|i)\s+(?:discussed|decided|agreed|said|mentioned|chose)\b/iu,
  /\bwhat\s+(?:did|have|had)\s+(?:we|you|i)\b/iu,
  /\b(?:find|search|review|summarize)\b.{0,24}\b(?:past|previous|earlier)\s+(?:conversation|chat|discussion|memory)\b/iu,
  /\b(?:only\s+)?(?:from|based\s+on)\s+(?:your\s+)?memory\b/iu,
] as const

const CHINESE_RECALL_PATTERNS = [
  /(?:还|還)?记得.{0,32}(?:吗|嗎|么|麼|？|\?)/u,
  /(?:上次|之前|以前|此前|过去|過去|曾经|曾經|上周|上週|上个月|上個月).{0,24}(?:讨论|討論|决定|決定|约定|約定|选择|選擇|说|說|提|偏好|方案|配置|记录|記錄|聊天|会话|會話|issue|bug)/iu,
  /(?:我们|我們|你|我).{0,10}(?:之前|以前|曾经|曾經).{0,20}(?:讨论|討論|决定|決定|约定|約定|说|說|提)/u,
  /(?:找|搜|搜索|查|翻).{0,12}(?:记忆|記憶|之前|以前|历史|歷史|聊天记录|聊天記錄|会话|會話)/u,
  /(?:记忆|記憶|跨会话|跨會話).{0,16}(?:什么|什麼|是否|有没有|有沒有|找|搜|查|校验码|校驗碼|偏好|约定|約定)/u,
  /只?根据(?:你的)?记忆|只?根據(?:你的)?記憶/u,
] as const

const FUTURE_OR_WRITE_PATTERNS = [
  /\b(?:remember|remind)\s+(?:me\s+)?(?:to|that)\b/iu,
  /\b(?:tomorrow|later|tonight|next (?:week|month|year))\b/iu,
  /(?:记住|記住|记一下|記一下|帮我记|幫我記|不要忘记|不要忘記)/u,
  /(?:明天|明早|今晚|今后|今後|以后|以後|待会|待會|等会|等會|稍后|稍後|下周|下週|下个月|下個月).{0,20}(?:记得|記得|提醒|发送|發送|执行|執行|运行|運行)/u,
] as const

const RETROSPECTIVE_MARKERS =
  /\b(?:previously|earlier|last time|used to|yesterday|ago)\b|(?:上次|之前|以前|此前|过去|過去|曾经|曾經|上周|上週|上个月|上個月|跨会话|跨會話)/iu

export function hasRecallIntent(queryText: string): boolean {
  const normalized = queryText.normalize('NFKC').trim()
  if (!normalized) return false
  const hasRetrospectiveMarker = RETROSPECTIVE_MARKERS.test(normalized)
  if (
    !hasRetrospectiveMarker &&
    FUTURE_OR_WRITE_PATTERNS.some(pattern => pattern.test(normalized))
  ) {
    return false
  }
  return (
    ENGLISH_RECALL_PATTERNS.some(pattern => pattern.test(normalized)) ||
    CHINESE_RECALL_PATTERNS.some(pattern => pattern.test(normalized))
  )
}

export function resolveMemoryRecallDecision(
  queryText: string,
  hasStrongFastHit: boolean,
): MemoryRecallDecision {
  if (hasStrongFastHit) return 'strong-fast-hit'
  return hasRecallIntent(queryText) ? 'recall' : 'no-recall-intent'
}

/**
 * Scan transcript for past relevant_memories attachments.
 * Compact that drops attachments naturally resets both counters.
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (isAttachmentMessage(m) && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

function getUserMessageText(msg: Message): string | undefined {
  if (!isRoleMessage(msg) || msg.role !== 'user') return undefined
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter(p => p.type === 'text')
    .map(p => (p.type === 'text' ? p.text : ''))
    .join('\n')
}

/**
 * Tools that succeeded (never errored) since the previous real user turn.
 */
export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): string[] {
  const lastUserIdx = messages.lastIndexOf(lastUserMessage)
  if (lastUserIdx < 0) return []

  const errored = new Set<string>()
  const succeeded = new Set<string>()
  const toolNameById = new Map<string, string>()

  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (!isRoleMessage(m)) continue
    if (m.role === 'assistant') {
      for (const part of m.content) {
        if (part.type === 'tool-call') {
          toolNameById.set(part.toolCallId, part.toolName)
        }
      }
    }
    if (m.role === 'tool') {
      for (const part of m.content) {
        const name = part.toolName || toolNameById.get(part.toolCallId)
        if (!name) continue
        const isErr =
          part.isError === true ||
          (typeof part.output?.value === 'string' &&
            /error|failed/i.test(part.output.value.slice(0, 200)))
        if (isErr) {
          errored.add(name)
          succeeded.delete(name)
        } else if (!errored.has(name)) {
          succeeded.add(name)
        }
      }
    }
  }
  return [...succeeded]
}

export type StartPrefetchOpts = {
  config: AutoMemoryConfig
  /** Default auto-memory directory when no @agent mention overrides. */
  memPath: string
  /**
   * Optional override directories (@agent → agent memory dirs only).
   * When set and non-empty, search these instead of memPath.
   */
  memPaths?: string[]
  provider: IProvider
  modelId: string
  readFileState?: ReadFileState
  abortSignal?: AbortSignal
  /** Optional test inject. */
  selectFn?: SelectRelevantFn
  /** Override query text (defaults to last non-meta user message). */
  queryText?: string
  sessionId?: string
}

function resolveSearchDirs(opts: StartPrefetchOpts): string[] {
  if (opts.memPaths && opts.memPaths.length > 0) return opts.memPaths
  return [opts.memPath]
}

/**
 * Start relevance search; never blocks the main turn.
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  opts: StartPrefetchOpts,
): MemoryPrefetch | undefined {
  if (!opts.config.enabled || opts.config.prefetchEnabled === false) {
    return undefined
  }
  messages = getActiveModelMessages(messages, opts.sessionId)

  let input = opts.queryText
  let lastUser: Message | undefined
  if (!input) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        isRoleMessage(m) &&
        m.role === 'user' &&
        !m.isMeta &&
        !m.isCompactSummary
      ) {
        lastUser = m
        input = getUserMessageText(m)
        break
      }
    }
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        isRoleMessage(m) &&
        m.role === 'user' &&
        !m.isMeta &&
        !m.isCompactSummary
      ) {
        lastUser = m
        break
      }
    }
  }

  if (!input?.trim()) {
    return undefined
  }
  const trimmed = input.trim()

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= MAX_SESSION_BYTES) {
    return undefined
  }

  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  opts.abortSignal?.addEventListener('abort', onParentAbort, { once: true })

  const recentTools = lastUser
    ? collectRecentSuccessfulTools(messages, lastUser)
    : []
  const readFileState = opts.readFileState
  const unavailablePaths = new Set(surfaced.paths)
  for (const filePath of readFileState?.keys() ?? []) {
    unavailablePaths.add(filePath)
  }
  const searchDirs = resolveSearchDirs(opts)
  // Strong hit if any dir had a strong exclusive result — recompute per dir.
  let immediateStrong = false
  const strongFromDirs: Array<{
    path: string
    mtimeMs: number
    score: number
  }> = []
  for (const dir of searchDirs) {
    const fast = findFastRelevantMemories(trimmed, dir, unavailablePaths)
    if (fast.strong) {
      immediateStrong = true
      strongFromDirs.push(...fast.matches)
    }
  }
  const fastMemories = immediateStrong
    ? readMemoriesForSurfacingSync(
        strongFromDirs.slice(0, 5),
        controller.signal,
      )
    : []
  const immediate: Attachment[] =
    fastMemories.length > 0
      ? [{ type: 'relevant_memories' as const, memories: fastMemories }]
      : []

  // Keep the cheap short-query suppression for the model lane only. Exact
  // filenames, identifiers, and short CJK prompts still reach the fast lane.
  const skipSemantic =
    immediateStrong || (!/\s/.test(trimmed) && trimmed.length < 10)
  if (skipSemantic && immediate.length === 0) {
    controller.abort()
    opts.abortSignal?.removeEventListener('abort', onParentAbort)
    return undefined
  }

  const promise = (async (): Promise<Attachment[]> => {
    if (skipSemantic) return []
    try {
      const allSelected = (
        await Promise.all(
          searchDirs.map(dir =>
            findRelevantMemories(
              input!,
              dir,
              {
                provider: opts.provider,
                modelId: opts.modelId,
                signal: controller.signal,
                selectFn: opts.selectFn,
              },
              recentTools,
              unavailablePaths,
            ).catch(() => []),
          ),
        )
      ).flat()
      const filtered = allSelected
        .filter(
          m =>
            !surfaced.paths.has(m.path) &&
            !(readFileState && readFileState.has(m.path)),
        )
        .slice(0, 5)
      const memories = await readMemoriesForSurfacing(
        filtered,
        controller.signal,
      )
      if (memories.length === 0) return []
      return [{ type: 'relevant_memories' as const, memories }]
    } catch (e) {
      if (controller.signal.aborted) return []
      console.warn(
        `[auto-memory] prefetch failed: ${e instanceof Error ? e.message : e}`,
      )
      return []
    }
  })()

  const handle: MemoryPrefetch = {
    immediate,
    immediateStrong,
    immediateConsumedOnIteration: -1,
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    dispose() {
      controller.abort()
      opts.abortSignal?.removeEventListener('abort', onParentAbort)
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

function attachmentMessages(
  attachments: readonly Attachment[],
  readFileState: ReadFileState | undefined,
): AttachmentMessage[] {
  const out: AttachmentMessage[] = []
  for (const attachment of attachments) {
    if (attachment.type !== 'relevant_memories') continue
    const memories = attachment.memories.filter(
      memory => !(readFileState && readFileState.has(memory.path)),
    )
    if (memories.length === 0) continue
    out.push(
      createAttachmentMessage({
        type: 'relevant_memories',
        memories,
      }),
    )
  }
  return out
}

/** Consume deterministic strong matches independently from the semantic lane. */
export function consumeImmediateMemoryPrefetch(
  prefetch: MemoryPrefetch | undefined,
  readFileState: ReadFileState | undefined,
  iterationIndex: number,
): AttachmentMessage[] {
  if (!prefetch || prefetch.immediateConsumedOnIteration !== -1) return []
  prefetch.immediateConsumedOnIteration = iterationIndex
  return attachmentMessages(prefetch.immediate, readFileState)
}

/** Consume settled prefetch into attachment messages (zero-wait if settled). */
export async function consumeMemoryPrefetchIfReady(
  prefetch: MemoryPrefetch | undefined,
  readFileState: ReadFileState | undefined,
  iterationIndex: number,
): Promise<AttachmentMessage[]> {
  if (
    !prefetch ||
    prefetch.settledAt === null ||
    prefetch.consumedOnIteration !== -1
  ) {
    return []
  }
  const attachments = await prefetch.promise
  prefetch.consumedOnIteration = iterationIndex
  return attachmentMessages(attachments, readFileState)
}

/**
 * Wait a bounded amount for explicit recall. A timeout leaves the semantic
 * lane unconsumed so post-turn can still attach a late result.
 */
export async function consumeMemoryPrefetchWithTimeout(
  prefetch: MemoryPrefetch | undefined,
  readFileState: ReadFileState | undefined,
  iterationIndex: number,
  timeoutMs: number = EXPLICIT_RECALL_TIMEOUT_MS,
): Promise<TimedMemoryPrefetchResult> {
  if (!prefetch || prefetch.consumedOnIteration !== -1) {
    return { attachments: [], timedOut: false }
  }
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    prefetch.promise.then(() => false),
    new Promise<true>(resolve => {
      timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs))
    }),
  ])
  if (timer) clearTimeout(timer)
  if (timedOut) return { attachments: [], timedOut: true }
  return {
    attachments: await consumeMemoryPrefetchIfReady(
      prefetch,
      readFileState,
      iterationIndex,
    ),
    timedOut: false,
  }
}

/** Helper for tests / ToolUseContext typing. */
export type PrefetchToolUseContext = ToolUseContext & {
  memoryPrefetch?: MemoryPrefetch
}
