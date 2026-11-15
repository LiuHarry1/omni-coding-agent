/**
 * Forked agent helper for side-path runs that reuse main-loop cache context.
 *
 * Shared infrastructure for **side-path** agent loops that:
 * 1. Optionally reuse parent prompt-cache-critical params (`CacheSafeParams`)
 * 2. Isolate mutable ToolContext from the parent (`createSubagentContext`)
 * 3. Gate tools via `canUseTool` (e.g. Session Memory: Edit only on summary.md)
 * 4. Do not recurse into session-memory extract / UI wire by default
 *
 * This is NOT Explore/Plan **subagents** (those start with `messages: []` via
 * AgentTool). Forked agents typically continue the parent message prefix.
 *
 */
import type {
  AnyTool,
  CompactionConfig,
  IEventBus,
  IProvider,
  Message,
  RunAgentFn,
  ToolContext,
} from './types.js'
import type { CanUseToolFn } from './can-use-tool.js'
import type { ReadFileState } from '../utils/read/types.js'
import { runWithForkedReadFileState } from '../utils/read/read-file-state.js'
export type { CanUseToolFn, PermissionDecision } from './can-use-tool.js'
import { EventBus } from './event-bus.js'
import { noopWireEmitter, type WireEmitter } from './wire-emitter.js'
import { DEFAULTS } from './settings-manager.js'
import * as path from 'path'

// ── Cache-safe params ───────────────────────────

/**
 * Fields that must stay identical to the parent API request to share the
 * parent's prompt cache (Anthropic cache key ≈ system + tools + model +
 * message prefix). Thinking/max-output differences can still bust the cache.
 */
export type CacheSafeParams = {
  systemPrompt: string
  tools: Record<string, AnyTool>
  provider: IProvider
  model: string
  /** Parent conversation prefix the fork continues from. */
  forkContextMessages: Message[]
  /** Optional parent ToolContext to isolate from. */
  toolUseContext?: ToolContext
}

/** Build cache-safe params from a main-agent turn snapshot. */
export function createCacheSafeParams(input: {
  systemPrompt: string
  tools: Record<string, AnyTool>
  provider: IProvider
  model: string
  messages: Message[]
  toolUseContext?: ToolContext
}): CacheSafeParams {
  return {
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    provider: input.provider,
    model: input.model,
    forkContextMessages: input.messages,
    toolUseContext: input.toolUseContext,
  }
}

// ── Subagent / fork context isolation ───────────

export type SubagentContextOverrides = Partial<ToolContext> & {
  /** Share parent's eventBus (default: fresh bus). */
  shareEventBus?: boolean
  /** Share parent's wire (default: noop — silent forks). */
  shareWire?: boolean
}

/**
 * Isolated ToolContext for forks / subagents.
 * By default: new EventBus, noop wire, no sessionMemory, compaction off.
 */
export function createSubagentContext(
  parent?: ToolContext,
  overrides?: SubagentContextOverrides,
): ToolContext {
  const { shareEventBus, shareWire, ...fieldOverrides } = overrides ?? {}

  return {
    eventBus:
      fieldOverrides.eventBus ??
      (shareEventBus && parent ? parent.eventBus : new EventBus()),
    wire:
      fieldOverrides.wire ??
      (shareWire && parent ? parent.wire : noopWireEmitter),
    middleware: fieldOverrides.middleware,
    runAgent: fieldOverrides.runAgent ?? parent?.runAgent,
    registry: fieldOverrides.registry ?? parent?.registry,
    mcpTools: fieldOverrides.mcpTools,
    toolEnablement: fieldOverrides.toolEnablement ?? parent?.toolEnablement,
    provider: fieldOverrides.provider ?? parent?.provider,
    models: fieldOverrides.models ?? parent?.models,
    compaction:
      fieldOverrides.compaction ??
      ({ ...DEFAULTS.compaction, enabled: false } satisfies CompactionConfig),
    // Background forks must not re-trigger session-memory extract unless opted in.
    sessionMemory: fieldOverrides.sessionMemory,
    lspServers: fieldOverrides.lspServers ?? parent?.lspServers,
    sessionId: fieldOverrides.sessionId ?? parent?.sessionId,
    session: fieldOverrides.session,
    cwd: fieldOverrides.cwd ?? parent?.cwd,
    permissionContext:
      fieldOverrides.permissionContext ?? parent?.permissionContext,
  }
}

// ── Tool wrapping ───────────────────────────────

/** Wrap tool execute handlers with a canUseTool gate. */
export function applyCanUseTool(
  tools: Record<string, AnyTool>,
  canUseTool?: CanUseToolFn,
  logLabel?: string,
): Record<string, AnyTool> {
  if (!canUseTool) return tools

  const tag = `agent:${logLabel ?? 'fork'}`
  const out: Record<string, AnyTool> = {}
  for (const [name, t] of Object.entries(tools)) {
    const original = t as AnyTool & {
      execute?: (args: unknown, options?: unknown) => Promise<unknown>
    }
    if (typeof original.execute !== 'function') {
      out[name] = t
      continue
    }
    const execute = original.execute.bind(original)
    out[name] = {
      ...original,
      execute: async (args: unknown, options?: unknown) => {
        const decision = await canUseTool(name, args)
        if (decision.behavior === 'deny') {
          console.log(`[${tag}] tool_deny ${name}`)
          return decision.message
        }
        console.log(`[${tag}] tool_allow ${name}`)
        const input =
          decision.updatedInput !== undefined ? decision.updatedInput : args
        return execute(input, options)
      },
    } as AnyTool
  }
  return out
}

type ToolExecute = (args: unknown, options?: unknown) => Promise<unknown>

/**
 * Replace one tool's `execute` while keeping description/inputSchema.
 * Used so Session Memory can write under `.sessions/` (sandbox bypass)
 * without changing the API tools[] payload (prompt-cache stability).
 */
export function overrideToolExecute(
  tools: Record<string, AnyTool>,
  toolName: string,
  execute: ToolExecute,
): Record<string, AnyTool> {
  const original = tools[toolName]
  if (!original) return tools
  return {
    ...tools,
    [toolName]: {
      ...original,
      execute,
    } as AnyTool,
  }
}

// ── runForkedAgent ──────────────────────────────

export type ForkedAgentParams = {
  /** New user turn appended after forkContextMessages (the fork instruction). */
  prompt: string
  /** Agent loop entry (usually the exported `runAgent`). */
  runAgent: RunAgentFn
  /**
   * Prefer this for cache-sharing forks: same system/tools/model + parent
   * message prefix as the main turn. Pair with `canUseTool` to restrict
   * execution without dropping tools from the request schema.
   */
  cacheSafeParams?: CacheSafeParams
  /** Used when `cacheSafeParams` is omitted (restricted / non-cache forks). */
  systemPrompt?: string
  tools?: Record<string, AnyTool>
  provider?: IProvider
  model?: string
  forkContextMessages?: Message[]
  canUseTool?: CanUseToolFn
  /** Analytics / log label (e.g. `session_memory`). */
  forkLabel?: string
  maxSteps?: number
  cwd?: string
  sessionId?: string
  wire?: WireEmitter
  eventBus?: IEventBus
  compaction?: CompactionConfig
  /** Extra ToolContext overrides for the fork. */
  contextOverrides?: SubagentContextOverrides
}

export type ForkedAgentResult = {
  /** Final text returned by `runAgent`. */
  text: string
  /** Duration of the fork loop. */
  durationMs: number
  forkLabel: string
}

/**
 * Run a side-path agent loop with isolated context.
 *
 * @example Session Memory (restricted tools, no cache share)
 * ```ts
 * await runForkedAgent({
 *   prompt: updatePrompt,
 *   runAgent,
 *   systemPrompt: SESSION_MEMORY_FORK_SYSTEM_PROMPT,
 *   tools: { Edit: memoryEditTool },
 *   provider, model,
 *   forkContextMessages: messages.slice(),
 *   forkLabel: 'session_memory',
 *   maxSteps: 8,
 * })
 * ```
 *
 * @example Cache-safe fork (keep parent tools+system, gate with canUseTool)
 * ```ts
 * await runForkedAgent({
 *   prompt: instruction,
 *   runAgent,
 *   cacheSafeParams: createCacheSafeParams({ ... }),
 *   canUseTool: createMemoryFileCanUseTool(path),
 *   forkLabel: 'session_memory',
 * })
 * ```
 */
export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult> {
  const forkLabel = params.forkLabel ?? 'fork'
  const start = Date.now()

  const cache = params.cacheSafeParams
  const systemPrompt = cache?.systemPrompt ?? params.systemPrompt
  const provider = cache?.provider ?? params.provider
  const model = cache?.model ?? params.model
  const rawTools = cache?.tools ?? params.tools
  const forkContextMessages = (
    cache?.forkContextMessages ??
    params.forkContextMessages ??
    []
  ).slice()

  if (!systemPrompt) {
    throw new Error(`runForkedAgent[${forkLabel}]: systemPrompt required`)
  }
  if (!provider) {
    throw new Error(`runForkedAgent[${forkLabel}]: provider required`)
  }
  if (!model) {
    throw new Error(`runForkedAgent[${forkLabel}]: model required`)
  }
  if (!rawTools || Object.keys(rawTools).length === 0) {
    throw new Error(`runForkedAgent[${forkLabel}]: tools required`)
  }

  const tools = applyCanUseTool(rawTools, params.canUseTool, forkLabel)

  const isolated = createSubagentContext(cache?.toolUseContext, {
    ...params.contextOverrides,
    eventBus: params.eventBus ?? params.contextOverrides?.eventBus,
    wire: params.wire ?? params.contextOverrides?.wire,
    provider,
    cwd:
      params.cwd ?? params.contextOverrides?.cwd ?? cache?.toolUseContext?.cwd,
    sessionId:
      params.sessionId ??
      params.contextOverrides?.sessionId ??
      cache?.toolUseContext?.sessionId,
    compaction:
      params.compaction ??
      params.contextOverrides?.compaction ??
      ({ ...DEFAULTS.compaction, enabled: false } satisfies CompactionConfig),
    // Never inherit sessionMemory unless caller opts in via contextOverrides.
    sessionMemory: params.contextOverrides?.sessionMemory,
  })

  console.log(
    `[forked-agent] start label=${forkLabel} model=${model} ` +
      `tools=${Object.keys(tools).join(',')} ` +
      `contextMsgs=${forkContextMessages.length} ` +
      `cacheSafe=${cache ? 'yes' : 'no'}`,
  )

  const usageAcc = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    steps: 0,
  }
  const unsubUsage = isolated.eventBus.on('usage', data => {
    const e = data as {
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      cacheWriteTokens?: number
    }
    usageAcc.inputTokens += e.inputTokens ?? 0
    usageAcc.outputTokens += e.outputTokens ?? 0
    usageAcc.cachedInputTokens += e.cachedInputTokens ?? 0
    usageAcc.cacheWriteTokens += e.cacheWriteTokens ?? 0
    usageAcc.steps += 1
  })

  // The fork's file tools resolve through `activeReadFileState`, so their reads
  // land here instead of the session map — even though the tool instances were
  // bound to the parent's ToolContext at create time.
  const forkReadFileState: ReadFileState = new Map()

  try {
    const text = await runWithForkedReadFileState(forkReadFileState, () =>
      params.runAgent(params.prompt, {
        throwOnError: true,
        tools,
        systemPrompt,
        eventBus: isolated.eventBus,
        wire: isolated.wire,
        messages: forkContextMessages,
        maxSteps: params.maxSteps,
        model,
        provider,
        canUseTool: params.canUseTool,
        cwd: isolated.cwd ?? process.cwd(),
        compaction: isolated.compaction,
        // Explicitly omit sessionMemory / sessionMemoryModelId — no nested extract.
        sessionId: isolated.sessionId,
        logLabel: forkLabel,
      }),
    )

    const durationMs = Date.now() - start
    const fmt = (n: number) => n.toLocaleString()
    const usageParts = [
      `in=${fmt(usageAcc.inputTokens)}`,
      `out=${fmt(usageAcc.outputTokens)}`,
      `cached=${fmt(usageAcc.cachedInputTokens)}`,
      `cache_write=${fmt(usageAcc.cacheWriteTokens)}`,
    ]
    console.log(
      `[forked-agent] done label=${forkLabel} durationMs=${durationMs} ` +
        `textChars=${typeof text === 'string' ? text.length : 0} ` +
        `steps=${usageAcc.steps} usage[${usageParts.join(' ')}]`,
    )
    return { text, durationMs, forkLabel }
  } catch (err) {
    const durationMs = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[forked-agent] failed label=${forkLabel} durationMs=${durationMs}: ${msg}`,
    )
    throw err
  } finally {
    unsubUsage()
    const discarded = forkReadFileState.size
    forkReadFileState.clear()
    if (discarded > 0) {
      console.log(
        `[forked-agent] label=${forkLabel} discarded ${discarded} read-file entries (fork isolation)`,
      )
    }
  }
}

/**
 * Resolve a tool file_path against an allowed absolute path.
 * Used by canUseTool gates and path-locked Edit tools.
 */
export function resolveToolFilePath(filePath: string, cwd?: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath)
  return path.resolve(cwd ?? process.cwd(), filePath)
}

export function pathsMatchExact(
  filePath: string,
  allowedAbsPath: string,
  cwd?: string,
): boolean {
  return (
    path.resolve(resolveToolFilePath(filePath, cwd)) ===
    path.resolve(allowedAbsPath)
  )
}

/**
 * Helper: allow only Edit on an exact absolute path.
 * Use with `canUseTool` while keeping other tools in the schema for cache hits,
 * or with a single-Edit toolset for restricted forks.
 */
export function createPathScopedEditCanUseTool(
  toolName: string,
  allowedAbsPath: string,
): CanUseToolFn {
  const allowed = path.resolve(allowedAbsPath)
  return (name, input) => {
    if (name !== toolName) {
      return {
        behavior: 'deny',
        message: `only ${toolName} on ${allowed} is allowed`,
      }
    }
    if (
      typeof input === 'object' &&
      input !== null &&
      'file_path' in input &&
      typeof (input as { file_path: unknown }).file_path === 'string'
    ) {
      const filePath = (input as { file_path: string }).file_path
      if (pathsMatchExact(filePath, allowed)) {
        return { behavior: 'allow', updatedInput: input }
      }
    }
    return {
      behavior: 'deny',
      message: `only ${toolName} on ${allowed} is allowed`,
    }
  }
}
