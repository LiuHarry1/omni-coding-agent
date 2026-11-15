/**
 * Auto-compact orchestrator: dynamic threshold, circuit breaker, config,
 * and the main compactIfNeeded entry point.
 *
 * Order after micro: wait session-memory extraction → try SM compact →
 * else full LLM compact. Both append boundary + summary + attachments;
 * session-memory additionally references a preserved tail through metadata.
 */
import { clearPromptSections } from '../../prompts/section-cache.js'
import type {
  CompactionConfig,
  IEventBus,
  IProvider,
  Message,
  RunAgentFn,
  SessionMemoryConfig,
  TodoItem,
} from '../../core/types.js'
import type { CacheSafeParams } from '../../core/forked-agent.js'
import type { WireEmitter } from '../../core/wire-emitter.js'
import { isRoleMessage } from '../../core/types.js'
import { DEFAULTS } from '../../core/settings-manager.js'
import type { ReadFileState } from '../../utils/read/types.js'
import { clearReadFileState } from '../../utils/read/read-file-state.js'
import { tokenCountWithEstimation } from './tokens.js'
import {
  applyMicroCompactProjection,
  microCompact,
  rebaseMicroCompactState,
  resetMicroCompactState,
} from './microCompact.js'
import {
  compactConversation,
  type CompactContext,
  type CompactEnrichment,
} from './compact.js'
import { buildPostCompactAttachmentMessages } from './post-compact-attachments.js'
import { extractRecentlyReadFiles, restoreRecentFiles } from './fileRestore.js'
import {
  clearLastSummarizedMessageId,
  ensureMessageUuids,
  trySessionMemoryCompaction,
} from '../session-memory/index.js'

// ── Threshold constants ─────────────────────────────────

const RESERVED_FOR_OUTPUT = 20_000
const AUTOCOMPACT_BUFFER = 13_000
const MICRO_COMPACT_HEADSTART = 27_000
/** Max share of the compaction threshold that post-compact file restore may use. */
const FILE_RESTORE_THRESHOLD_SHARE = 0.25
const WARNING_BUFFER = 20_000
const MANUAL_COMPACT_BUFFER = 3_000

// ── Config ──────────────────────────────────────────────

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * The env override, else the window of the model being called, else the
 * compaction setting.
 */
function getCompactionConfig(base?: CompactionConfig, provider?: IProvider) {
  const c = base ?? DEFAULTS.compaction
  return {
    enabled:
      process.env.DISABLE_AUTO_COMPACT === '1'
        ? false
        : process.env.DISABLE_COMPACT === '1'
          ? false
          : c.enabled,
    contextWindow: parseEnvInt(
      'COMPACT_CONTEXT_WINDOW',
      provider?.contextWindow?.() ?? c.contextWindow,
    ),
    microCompactKeepRecent: parseEnvInt(
      'COMPACT_MICRO_KEEP',
      c.microCompactKeepRecent,
    ),
    maxFilesToRestore: c.maxFilesToRestore,
    maxTokensPerFile: c.maxTokensPerFile,
    fileBudget: c.fileBudget,
    maxOutputTokens: c.maxOutputTokens,
    timeBasedMicroEnabled:
      process.env.DISABLE_TIME_BASED_MICRO === '1'
        ? false
        : !!c.timeBasedMicroEnabled,
    timeBasedMicroGapMinutes: parseEnvInt(
      'COMPACT_TIME_GAP_MIN',
      c.timeBasedMicroGapMinutes ?? 5,
    ),
  }
}

function shouldTimeBasedMicro(
  messages: Message[],
  enabled: boolean,
  gapMinutes: number,
): boolean {
  if (!enabled) return false
  let lastTs: number | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (
      isRoleMessage(m) &&
      m.role === 'assistant' &&
      typeof m.timestamp === 'number'
    ) {
      lastTs = m.timestamp
      break
    }
  }
  if (lastTs === undefined) return false
  const gap = (Date.now() - lastTs) / 60_000
  return Number.isFinite(gap) && gap >= gapMinutes
}

function getReservedForOutput(maxOutputTokens?: number): number {
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
    return Math.min(maxOutputTokens, RESERVED_FOR_OUTPUT)
  }
  return RESERVED_FOR_OUTPUT
}

function getEffectiveContextWindow(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  return contextWindow - getReservedForOutput(maxOutputTokens)
}

function getAutoCompactThreshold(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  const override = parseEnvInt('COMPACT_THRESHOLD_OVERRIDE', -1)
  if (override > 0) return override
  return (
    getEffectiveContextWindow(contextWindow, maxOutputTokens) -
    AUTOCOMPACT_BUFFER
  )
}

function getMicroCompactThreshold(autoCompactThreshold: number): number {
  return autoCompactThreshold - MICRO_COMPACT_HEADSTART
}

function getBlockingLimit(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  return (
    getEffectiveContextWindow(contextWindow, maxOutputTokens) -
    MANUAL_COMPACT_BUFFER
  )
}

/** Where compaction starts and where a request no longer fits, in tokens. */
export function compactionLimits(
  compaction?: CompactionConfig,
  provider?: IProvider,
): {
  contextWindow: number
  threshold: number
  blockingLimit: number
  autoCompactEnabled: boolean
} {
  const cfg = getCompactionConfig(compaction, provider)
  return {
    autoCompactEnabled: cfg.enabled,
    contextWindow: cfg.contextWindow,
    threshold: getAutoCompactThreshold(cfg.contextWindow, cfg.maxOutputTokens),
    blockingLimit: getBlockingLimit(cfg.contextWindow, cfg.maxOutputTokens),
  }
}

// ── Circuit breaker ─────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3
let consecutiveFailures = 0

export function resetCompactionFailures(): void {
  consecutiveFailures = 0
}

// ── Public entry ────────────────────────────────────────

export interface CompactOptions {
  force?: boolean
  aggressive?: boolean
  trigger?: 'manual' | 'auto'
  /** Steering text for a manual `/compact <instructions>` summarization. */
  instructions?: string
  /** Re-announce agent/skill listings after full compact. */
  enrichment?: CompactEnrichment
  /** Session-memory config; when set, prefer SM compact before full LLM. */
  sessionMemory?: SessionMemoryConfig
  /** Session Read cache — invalidated when Read tool_results are micro-cleared / full-compacted. */
  readFileState?: ReadFileState
  /** Main-loop runner for a cache-safe full-compact fork. */
  runAgent?: RunAgentFn
  /** Cache-critical main-loop params; the orchestrator refreshes its message prefix after microcompact. */
  cacheSafeParams?: CacheSafeParams
}

/** What `compactIfNeeded` did. Callers persist a checkpoint only for summarizing sources. */
export type CompactSource = 'none' | 'micro' | 'session_memory' | 'full'

export type CompactOutcome = {
  /** Active model view after compaction. */
  messages: Message[]
  /** Events to append to the complete transcript for summarizing compacts. */
  appendMessages?: Message[]
  source: CompactSource
}

export function isSummarizingCompactSource(
  source: CompactSource,
): source is 'session_memory' | 'full' {
  return source === 'session_memory' || source === 'full'
}

function none(messages: Message[]): CompactOutcome {
  return { messages, source: 'none' }
}

function afterMicro(original: Message[], working: Message[]): CompactOutcome {
  return {
    messages: working,
    source: working !== original ? 'micro' : 'none',
  }
}

/**
 * Main compaction entry point. Called before each agent step.
 *
 * Flow: microcompact first (API-view only), then session-memory / full LLM
 * if still over threshold. Summarizing outcomes expose append-only compact
 * events; microcompact remains an API-view only.
 */
export async function compactIfNeeded(
  ...args: Parameters<typeof compactMessages>
): Promise<CompactOutcome> {
  const outcome = await compactMessages(...args)
  const sessionId = args[9]
  // A summary starts the cached prefix over, so stale sections can refresh.
  if (sessionId && isSummarizingCompactSource(outcome.source)) {
    clearPromptSections(sessionId)
  }
  return outcome
}

async function compactMessages(
  messages: Message[],
  eventBus: IEventBus,
  wire: WireEmitter,
  mainModel: string,
  cwd: string,
  currentTodos: TodoItem[],
  opts: CompactOptions = {},
  compaction?: CompactionConfig,
  provider?: IProvider,
  sessionId?: string,
): Promise<CompactOutcome> {
  const cfg = getCompactionConfig(compaction, provider)
  const force = !!opts.force
  const aggressive = !!opts.aggressive
  const smConfig = opts.sessionMemory ?? DEFAULTS.sessionMemory

  if (messages.length === 0) return none(messages)
  ensureMessageUuids(messages)
  messages = applyMicroCompactProjection(messages, sessionId)

  if (!force && !aggressive && !cfg.enabled) {
    return none(messages)
  }

  if (!force && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return none(messages)
  }

  const { threshold, blockingLimit } = compactionLimits(compaction, provider)
  const microThreshold = getMicroCompactThreshold(threshold)
  let tokens = tokenCountWithEstimation(messages).total

  if (
    tokens >= threshold - WARNING_BUFFER &&
    tokens < threshold &&
    !force &&
    !aggressive
  ) {
    eventBus.emit('compaction_warning', {
      currentTokens: tokens,
      threshold,
      percentLeft: Math.max(
        0,
        Math.round(((threshold - tokens) / threshold) * 100),
      ),
    })
  }

  if (tokens >= blockingLimit) {
    eventBus.emit('compaction_blocking', {
      currentTokens: tokens,
      blockingLimit,
    })
  }

  // STEP 1 -- micro-compaction
  let working = messages
  const microKeep = aggressive ? 1 : cfg.microCompactKeepRecent
  const timeBased =
    !aggressive &&
    !force &&
    shouldTimeBasedMicro(
      messages,
      cfg.timeBasedMicroEnabled,
      cfg.timeBasedMicroGapMinutes,
    )
  const shouldMicro =
    aggressive || force || tokens >= microThreshold || timeBased
  if (shouldMicro) {
    console.log(
      `[compact] micro-compact START -- msgs=${working.length}, tokens~${tokens.toLocaleString()}, ` +
        `microThreshold=${microThreshold.toLocaleString()}, keepRecent=${microKeep}` +
        (aggressive ? ', aggressive' : '') +
        (force ? ', force' : '') +
        (timeBased
          ? `, time-based(gap>${cfg.timeBasedMicroGapMinutes}min)`
          : ''),
    )
    const tokensBeforeMicro = tokens
    const r = microCompact(working, microKeep, sessionId, {
      cwd,
      readFileState: opts.readFileState,
    })
    tokens = Math.max(0, tokensBeforeMicro - r.tokensFreed)
    if (r.cleared > 0) {
      eventBus.emit('compaction_micro', {
        cleared: r.cleared,
        tokensFreed: r.tokensFreed,
      })
      working = r.messages
    }
    console.log(
      `[compact] micro-compact DONE -- cleared=${r.cleared}, freed~${r.tokensFreed.toLocaleString()} tokens, ` +
        `tokens ${tokensBeforeMicro.toLocaleString()} -> ${tokens.toLocaleString()}, msgs=${working.length}`,
    )
  }

  // STEP 2 -- SM or full summarization
  if (!force && !aggressive && tokens < threshold) {
    return afterMicro(messages, working)
  }

  const msgsBeforeFull = working.length
  const tokensBeforeFull = tokens
  console.log(
    `[compact] compact START -- msgs=${msgsBeforeFull}, tokens~${tokensBeforeFull.toLocaleString()}, ` +
      `fullThreshold=${threshold.toLocaleString()}` +
      (aggressive ? ', aggressive' : '') +
      (force ? ', force' : ''),
  )

  eventBus.emit('compaction_start', {
    totalMessages: working.length,
    keeping: 1,
    estimatedTokens: tokens,
    aggressive,
  })
  wire.compactionStart({
    messages_before: working.length,
    tokens_before: tokens,
  })

  // Clamp the restore budget to a slice of the compaction target. The raw
  // budget is sized for a full-size context window; on a small configured
  // window it can exceed the threshold on its own, so compaction would
  // re-trigger forever on the content it just re-injected.
  const fileRestore = {
    maxFiles: cfg.maxFilesToRestore,
    maxTokensPerFile: cfg.maxTokensPerFile,
    totalBudget: Math.min(
      cfg.fileBudget,
      Math.max(0, Math.floor(threshold * FILE_RESTORE_THRESHOLD_SHARE)),
    ),
  }
  const skipFileRestore = aggressive
  const buildFileSection = (preserved: readonly Message[]): string =>
    skipFileRestore
      ? ''
      : restoreRecentFiles(
          extractRecentlyReadFiles(working),
          cwd,
          fileRestore,
          preserved,
        )

  const attachmentMessages = opts.enrichment
    ? await buildPostCompactAttachmentMessages(cwd, opts.enrichment)
    : []

  // Prefer session-memory notes unless the user steered summarization.
  const preferSm = !!sessionId && smConfig.enabled && !opts.instructions?.trim()

  if (preferSm) {
    try {
      const sm = await trySessionMemoryCompaction({
        messages: working,
        sessionId,
        config: smConfig,
        autoCompactThreshold: force || aggressive ? undefined : threshold,
        attachmentMessages,
        todos: currentTodos,
        fileSection: buildFileSection,
        trigger: opts.trigger ?? 'auto',
        preTokens: tokensBeforeFull,
        estimateTokens: msgs => tokenCountWithEstimation(msgs).total,
      })
      if (sm) {
        consecutiveFailures = 0
        rebaseMicroCompactState(sessionId, sm.messagesToKeep, sm.messages)
        clearLastSummarizedMessageId(sessionId)
        clearReadFileState(opts.readFileState)
        eventBus.emit('compaction_done', {
          summary: sm.summaryText,
          summaryLength: sm.summaryText.length,
          estimatedTokensAfter: tokenCountWithEstimation(sm.messages).total,
          messagesBefore: msgsBeforeFull,
          source: 'session_memory',
        })
        const tokensAfter = tokenCountWithEstimation(sm.messages).total
        wire.compactionDone({
          status: 'ok',
          messages_after: sm.messages.length,
          tokens_after: tokensAfter,
        })
        console.log(
          `[compact] session-memory compact DONE -- msgs ${msgsBeforeFull} -> ${sm.messages.length}, ` +
            `tokens~${tokensBeforeFull.toLocaleString()} -> ${tokensAfter.toLocaleString()}, ` +
            `kept=${sm.messagesToKeep.length}`,
        )
        return {
          messages: sm.messages,
          appendMessages: sm.appendMessages,
          source: 'session_memory',
        }
      }
      console.log(
        `[compact] session-memory compact skipped -- falling back to full LLM`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[compact] session-memory compact error: ${msg}`)
    }
  }

  const ctx: CompactContext = {
    cwd,
    todos: currentTodos,
    fileRestore,
    instructions: opts.instructions,
    provider,
    enrichment: opts.enrichment,
    skipFileRestore,
    trigger: opts.trigger ?? 'auto',
    preTokens: tokensBeforeFull,
    runAgent: opts.runAgent,
    cacheSafeParams: opts.cacheSafeParams
      ? {
          ...opts.cacheSafeParams,
          forkContextMessages: working.slice(),
        }
      : undefined,
    preserveRecentTail: aggressive
      ? {
          minTokens: 10_000,
          maxTokens: 40_000,
          minTextMessages: 5,
        }
      : undefined,
  }

  try {
    const result = await compactConversation(working, mainModel, ctx)
    if (!result) {
      console.log(
        `[compact] full-compact DONE -- no change (summarizer returned empty), ` +
          `msgs=${msgsBeforeFull}, tokens~${tokensBeforeFull.toLocaleString()}`,
      )
      wire.compactionDone({ status: 'noop' })
      return afterMicro(messages, working)
    }

    consecutiveFailures = 0
    if (result.messagesToKeep.length > 0) {
      rebaseMicroCompactState(sessionId, result.messagesToKeep, result.messages)
    } else {
      resetMicroCompactState(sessionId)
    }
    if (sessionId) clearLastSummarizedMessageId(sessionId)
    clearReadFileState(opts.readFileState)
    eventBus.emit('compaction_done', {
      summary: result.summary,
      summaryLength: result.summaryLength,
      estimatedTokensAfter: result.estimatedTokensAfter,
      messagesBefore: msgsBeforeFull,
      source: 'full',
    })
    wire.compactionDone({
      status: 'ok',
      messages_after: result.messages.length,
      tokens_after: result.estimatedTokensAfter,
    })
    const willRetriggerNextTurn = result.estimatedTokensAfter >= threshold
    if (willRetriggerNextTurn) {
      console.warn(
        `[compact] WARNING: post-compact context (~${result.estimatedTokensAfter.toLocaleString()} tokens) ` +
          `still >= threshold (${threshold.toLocaleString()}) -- compaction will re-trigger next turn. ` +
          `Check contextWindow config, file restore budget, and oversized tool results.`,
      )
      eventBus.emit('compaction_will_retrigger', {
        tokensAfter: result.estimatedTokensAfter,
        threshold,
      })
    }
    console.log(
      `[compact] full-compact DONE -- msgs ${msgsBeforeFull} -> ${result.messages.length}, ` +
        `tokens~${tokensBeforeFull.toLocaleString()} -> ${result.estimatedTokensAfter.toLocaleString()}, ` +
        `summaryChars=${result.summaryLength.toLocaleString()}, kept=${result.messagesToKeep.length}` +
        (willRetriggerNextTurn ? ', WILL-RETRIGGER' : ''),
    )
    return {
      messages: result.messages,
      appendMessages: result.appendMessages,
      source: 'full',
    }
  } catch (error) {
    consecutiveFailures++
    const msg = error instanceof Error ? error.message : String(error)
    console.error(
      `[compact] full-compact FAILED -- msgs=${msgsBeforeFull}, tokens~${tokensBeforeFull.toLocaleString()}: ${msg}`,
    )
    eventBus.emit('compaction_error', { error: msg })
    wire.compactionDone({ status: 'error' })
    return afterMicro(messages, working)
  }
}
