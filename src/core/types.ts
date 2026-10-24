import type { Tool } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import type { IProvider } from './llm/types.js'
import type {
  ModelProfiles,
  ModelRegistry,
  ModelTier,
} from './llm/model-registry.js'
import type { ConcurrencyPolicyFn } from './concurrency-policy.js'
import type { ExternalMode, PermissionModeContext } from './permission-mode.js'
import type {
  Attachment,
  Diagnostic,
  DiagnosticFile,
} from '../utils/attachments/types.js'
import type { ReadFileState } from '../utils/read/types.js'

export type AnyTool = Tool<any, any>

// ── EventBus ────────────────────────────────────

export type EventHandler = (data: unknown, event: string) => void

export interface IEventBus {
  on(event: string, handler: EventHandler): () => void
  off(event: string, handler: EventHandler): void
  emit(event: string, data?: unknown): void
  scoped(prefix: string): IEventBus
  removeAllListeners(): void
}

// ── Middleware ───────────────────────────────────

export type MiddlewareHook = 'beforeTool' | 'afterTool' | 'onError'

export interface MiddlewareContext {
  name: string
  args: unknown
  startTime: number
  result?: unknown
  error?: unknown
  duration?: number
  /** Correlates timing / hooks to the in-flight tool_use when available. */
  toolCallId?: string
  /** Agent identity for console logs (e.g. `main`, `session_memory`). */
  logLabel?: string
}

export type MiddlewareHandler = (ctx: MiddlewareContext) => void | Promise<void>

export interface IMiddleware {
  use(hook: MiddlewareHook, handler: MiddlewareHandler): void
  wrap(
    name: string,
    executeFn: (args: unknown, options?: unknown) => Promise<unknown>,
  ): (args: unknown, options?: unknown) => Promise<unknown>
}

// ── Tool Registry ───────────────────────────────

export interface ToolContext {
  eventBus: IEventBus
  wire: import('./wire-emitter.js').WireEmitter
  middleware?: IMiddleware
  runAgent?: RunAgentFn
  registry?: IToolRegistry
  /** MCP tools keyed by merged name from MCPManager (e.g. `web_fetch`). Subagents list these in SubagentConfig.tools */
  mcpTools?: Record<string, AnyTool>
  /** From AppConfig: omit disabled tools in registry.createAll; subagents pass through for MCP merge + filter */
  toolEnablement?: Pick<AppConfig, 'disabledTools'>
  /** Request-scoped provider and compaction settings inherited by subagents. */
  provider?: IProvider
  /** Three-tier model registry (large / medium / small). */
  models?: ModelRegistry
  compaction?: CompactionConfig
  sessionMemory?: SessionMemoryConfig
  autoMemory?: AutoMemoryConfig
  /** Request-scoped LSP server configs from effective settings. */
  lspServers?: Record<string, LspServerConfig>
  /** Session id for persisting large tool outputs under `.sessions/{id}/`. */
  sessionId?: string
  /** Active session �?set on main-agent runs for mode/plan tools. */
  session?: Session
  /** Workspace cwd for plan file resolution. */
  cwd?: string
  /**
   * Request-scoped filesystem permission context (SSO: pinned userWorkspace,
   * mode `dontAsk`). Desktop is `default` (outside → ask).
   */
  permissionContext?: import('../utils/permissions/filesystem.js').FilesystemPermissionContext
  /**
   * Tool execution via isomorphic Agent Worker (RuntimePort RPC).
   * Always set for both local and SSH workspaces.
   */
  execution?: import('../execution/execution-backend.js').ExecutionBackend
}

export type ImageMediaType =
  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/** Anthropic `Base64ImageSource`. `data` is bare base64, no data: prefix. */
export interface Base64ImageSource {
  type: 'base64'
  media_type: ImageMediaType
  data: string
}

/** Anthropic `ImageBlockParam`. */
export interface ImageBlockParam {
  type: 'image'
  source: Base64ImageSource
}

/**
 * Blocks allowed inside `tool_result.content`. The wire format also permits
 * search_result / document blocks; we carry the two the agent produces.
 */
export type ToolResultContentBlockParam = TextPart | ImageBlockParam

/** API tool_result block produced by a mapper. */
export interface ToolResultBlockParam {
  tool_use_id: string
  type: 'tool_result'
  /**
   * String for text-only results, or content blocks when the tool returns
   * images (screenshots, image reads). Image blocks bypass tool-result disk
   * persistence and are dropped when `is_error` is set — the API rejects
   * non-text content on error results.
   */
  content: string | ToolResultContentBlockParam[]
  /** When true, tool_result is an error for the model / wire (Bash interrupt). */
  is_error?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  /** When false, the tool is never exposed to the model */
  enabled?: boolean
  /**
   * Marks tools created via `createSubagentDefinition`. Used to prevent
   * subagent �?subagent recursion: a subagent never inherits other subagents
   * as tools regardless of allow/deny lists.
   */
  isSubagent?: boolean
  /**
   * When true, the tool is deferred: its schema is excluded from the API
   * `tools[]` array until the model discovers it via `tool_search`. MCP
   * tools are auto-deferred (see `isDeferredTool`).
   */
  shouldDefer?: boolean
  /**
   * When true, the tool is never deferred �?full schema in the initial
   * prompt even when tool_search is enabled. For MCP tools, set via
   * config. Overrides both `shouldDefer` and the MCP auto-defer rule.
   */
  alwaysLoad?: boolean
  /**
   * When true for a given input, the tool may run in parallel with other
   * consecutive concurrency-safe calls in the same assistant turn. Runtime
   * policy �?the model is not told about this flag.
   */
  isConcurrencySafe?: (input: unknown) => boolean
  /**
   * Whether ESC/interrupt cancels an in-flight tool ('cancel') or blocks
   * until it finishes ('block'). Mutating tools default to block.
   */
  interruptBehavior?: () => 'cancel' | 'block'
  /**
   * Filesystem permission check. Read/Write tools
   * return allow / ask / deny; `createCanUseTool` maps ask under `dontAsk`.
   */
  checkPermissions?: (
    input: unknown,
    ctx: {
      cwd: string
      permissionContext?: import('../utils/permissions/filesystem.js').FilesystemPermissionContext
    },
  ) =>
    | import('../utils/permissions/filesystem.js').FsPermissionDecision
    | Promise<import('../utils/permissions/filesystem.js').FsPermissionDecision>
  /** Path argument used for Always-allow working-dir grants. */
  getPath?: (input: unknown) => string | undefined
  /**
   * Map structured `data` → model-facing tool_result text.
   * Required on built-in dual-channel tools; framework calls after execute.
   * Projection modes (document per tool):
   *   A — model gets body; UI gets chrome (Read, Web*)
   *   B — model gets ACK; UI gets diff/preview (Edit, Write)
   *   C — same streams; model may wrap; UI raw stdout/stderr (Bash)
   *   D — model orchestration; UI side panel / status (Todo, Ask)
   */
  mapToolResultToToolResultBlockParam?: (
    output: unknown,
    toolUseID: string,
  ) => ToolResultBlockParam
  /**
   * Validate Out before UI sees toolUseResult.
   * Built-in tools should set this; failed parse omits TUR (model text still OK).
   */
  outputSchema?: {
    safeParse: (value: unknown) => {
      success: boolean
      data?: unknown
      error?: unknown
    }
  }
  create(cwd: string, context: ToolContext): AnyTool
}

export interface IToolRegistry {
  register(def: ToolDefinition): void
  get(name: string): ToolDefinition | undefined
  list(): Array<{ name: string; description: string }>
  createAll(
    cwd: string,
    context: ToolContext,
    only?: string[],
  ): Record<string, AnyTool>
}

// ── Messages (AI SDK format) ────────────────────

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  image: string | Buffer | Uint8Array
  mediaType?: string
}

/**
 * Anthropic document block for native PDF input.
 * Prefer claim-check refs (`file://` or upload URL) in session; hydrate to
 * Buffer in `projectMessagesForApi` / `reviveBuffersInMessages`.
 */
export interface FilePart {
  type: 'file'
  data: string | Buffer | Uint8Array
  mediaType: string
  filename?: string
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  providerOptions?: ProviderOptions
}

/**
 * Reasoning part produced by reasoning models (e.g. OpenAI Responses API).
 * `providerOptions.openai.{ itemId, reasoningEncryptedContent }` carries the
 * opaque state that MUST be replayed verbatim on the next request, otherwise
 * the model loses its chain-of-thought across tool-call rounds.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  providerOptions?: ProviderOptions
}

export type UserContentPart = TextPart | ImagePart | FilePart
export type AssistantContentPart = TextPart | ReasoningPart | ToolCallPart

export type UserFileAttachment = {
  name: string
  kind: 'pdf' | 'text' | 'binary'
  size: number
}

export interface UserMessage {
  role: 'user'
  content: string | UserContentPart[]
  /** Original composer text when `content` was expanded for the model. */
  displayContent?: string
  /** Stable message id (session-memory cursor / keep boundary). */
  uuid?: string
  /** Meta attachments expanded for API �?hidden from UI when true. */
  isMeta?: boolean
  /** Composer file chips persisted for transcript reload. */
  files?: UserFileAttachment[]
  /** Epoch ms the chat turn this message opened started / finished. */
  turnStartTime?: number
  turnEndTime?: number
  /**
   * Full-compact summary injected for the model (isCompactSummary).
   * Hidden from chat view; UI shows a compact_boundary marker instead.
   */
  isCompactSummary?: boolean
}

export interface AttachmentMessage {
  type: 'attachment'
  attachment: Attachment
  uuid: string
  timestamp: string
  isMeta?: boolean
}

export type { Attachment, Diagnostic, DiagnosticFile, ReadFileState }

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContentPart[]
  /** Stable message id (session-memory cursor / keep boundary). */
  uuid?: string
  /**
   * API-round id (the provider's response id). One `streamText` call = one
   * round, so all assistant records from the same response (incl. parallel
   * tool-call splits) share this id. Used to group messages by API round for
   * PTL truncation and token estimation.
   */
  id?: string
  /**
   * Epoch-ms when this assistant response was received. Used by time-based
   * micro-compaction to measure the gap since the last model turn (the prompt
   * cache has likely gone cold past the TTL). Optional for backward-compat.
   */
  timestamp?: number
  /**
   * Real API usage from the response that produced this message (
   * usage lives ON the message so it persists to JSONL and survives session
   * restore �?the previous WeakMap-only storage lost the accurate baseline on
   * every server restart, forcing threshold checks onto chars/4 estimation
   * which badly undercounts CJK text). Optional for backward-compat.
   */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
  }
}

/** Parts of an AI SDK `content` tool output (subset we emit). */
export type ToolResultOutputContentPart =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string }

/**
 * AI SDK `ToolResultOutput`. `content` carries multimodal results (the wire
 * format nests image blocks in `tool_result.content`; the SDK equivalent is
 * a content array with `image-data` parts).
 */
export type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'content'; value: ToolResultOutputContentPart[] }

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
  /**
   * Envelope sibling: structured tool Output for UI / session reload.
   * Never sent to the model (stripped by projectMessagesForApi).
   */
  toolUseResult?: unknown
  /** Soft/hard tool failure flag from mapper or thrown errors. */
  isError?: boolean
}

export interface ToolMessage {
  role: 'tool'
  content: ToolResultPart[]
  /** Stable message id (session-memory cursor / keep boundary). */
  uuid?: string
}

export interface PreservedCompactSegment {
  /** First message in the preserved pre-compact tail. */
  headUuid: string
  /** Message after which the preserved tail is logically inserted. */
  anchorUuid: string
  /** Last message in the preserved pre-compact tail. */
  tailUuid: string
  /** Exact legacy snapshot order when the tail was not a contiguous range. */
  preservedUuids?: string[]
}

export interface CompactMetadata {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preCompactDiscoveredTools?: string[]
  preservedSegment?: PreservedCompactSegment
}

/** Persisted marker separating compacted history from its model summary. */
export interface SystemCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  /** Keeps role-discriminated message consumers exhaustively type-safe. */
  role?: never
  content: string
  isMeta: false
  timestamp: string
  uuid: string
  level: 'info'
  /** Last message before compaction in the logical transcript chain. */
  logicalParentUuid?: string
  compactMetadata: CompactMetadata
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | AttachmentMessage
  | SystemCompactBoundaryMessage

/**
 * Dual-channel tool execute return.
 * Model text comes from `mapToolResultToToolResultBlockParam`, not from here.
 */
export interface DualChannelToolResult<T = unknown> {
  data: T
  newMessages?: Message[]
}

export function isAttachmentMessage(msg: Message): msg is AttachmentMessage {
  return (msg as AttachmentMessage).type === 'attachment'
}

export type RoleMessage = UserMessage | AssistantMessage | ToolMessage

export function isRoleMessage(msg: Message): msg is RoleMessage {
  return 'role' in msg
}

/** minimal fields for attachment collection. */
export interface ToolUseContext {
  cwd: string
  session: Session
  readFileState: ReadFileState
  lspServers?: Record<string, LspServerConfig>
  options: { tools: Record<string, AnyTool> }
  /** Pre-formatted skill/deferred-tool listing for skill_listing attachment (turn 0). */
  skillListingContent?: string
  /** Active subagent definitions for agent_listing_delta attachments. */
  agentDefinitions?: { activeAgents: AgentDefinition[] }
  /** Local host can dynamically load `paths:` rules for touched files. */
  conditionalRulesEnabled?: boolean
}

// ── Agent ───────────────────────────────────────

export interface AgentOptions {
  /** Current agent-loop entry, injected for cache-safe side-path forks. */
  runAgent?: RunAgentFn
  /**
   * Throw when the query loop stops because of an LLM/stream error.
   * Main chat keeps the default graceful SSE behavior; subagents and
   * side-path forks enable this so failures are not reported as empty success.
   */
  throwOnError?: boolean
  tools: Record<string, AnyTool>
  systemPrompt: string
  eventBus: IEventBus
  wire: import('./wire-emitter.js').WireEmitter
  messages?: Message[]
  images?: string[]
  /**
   * Composer attachments already resolved to meta messages (PDF documents,
   * Read-style file attachments, binary notes). Injected just before the user
   * turn, after `@mention` attachments.
   */
  attachmentPrelude?: Message[]
  /** File-chip metadata stored on the visible user turn. */
  attachmentFiles?: UserFileAttachment[]
  /** Original composer text persisted for transcript rendering. */
  displayUserMessage?: string
  /** System-generated user turn (scheduled tasks). Hidden from some prefetch paths. */
  isMeta?: boolean
  /**
   * Optional step budget (`maxSteps` / maxTurns). When omitted, the loop runs until
   * the model stops calling tools (or errors) �?no artificial cap.
   */
  maxSteps?: number
  model?: string
  /** Request-scoped provider built from the resolved settings for this cwd. */
  provider: IProvider
  /** Request workspace; used by compaction and subagent runs. */
  cwd?: string
  /** Request-scoped compaction settings. */
  compaction?: CompactionConfig
  /** Session-memory (background notes + compact prefer-read). */
  sessionMemory?: SessionMemoryConfig
  /**
   * Model id for session-memory when `cacheSafe` is false.
   * Prefer resolving via `resolveSidePathModel` with a matching provider.
   * When `cacheSafe` is true, main-loop model is used via CacheSafeParams.
   */
  sessionMemoryModelId?: string
  /**
   * Provider for session-memory when `cacheSafe` is false.
   * Must match `sessionMemoryModelId`'s tier (tiers may use different baseURL).
   * Falls back to the main-loop `provider` when omitted.
   */
  sessionMemoryProvider?: IProvider
  /** Cross-session auto memory (turn-end extract + MEMORY.md inject). */
  autoMemory?: AutoMemoryConfig
  /**
   * Model id for auto-memory extract when `cacheSafe` is false.
   * Prefer resolving via `resolveSidePathModel` with a matching provider.
   * When `cacheSafe` is true, main-loop model is used via CacheSafeParams.
   */
  autoMemoryModelId?: string
  /**
   * Provider for auto-memory when `cacheSafe` is false.
   * Must match `autoMemoryModelId`'s tier (tiers may use different baseURL).
   * Falls back to the main-loop `provider` when omitted.
   */
  autoMemoryProvider?: IProvider
  /**
   * Prefetch handle started by the turn host (non-blocking relevance select).
   * Consumed post-tools inside runAgent; disposed by the host in finally.
   * Shape matches `MemoryPrefetch` in services/auto-memory/prefetch.ts.
   */
  memoryPrefetch?: {
    immediate: Attachment[]
    immediateStrong: boolean
    immediateConsumedOnIteration: number
    promise: Promise<Attachment[]>
    settledAt: number | null
    consumedOnIteration: number
    dispose: () => void
  }
  /**
   * Names of tools that are subagent wrappers. Used purely for UI: when
   * provided, the agent tags `tool_call` / `tool_input_start` events with
   * `isSubagent: true` so the frontend can render them with the special
   * "subagent" card style + auto-expanded nested step list.
   */
  subagentNames?: Set<string>
  /**
   * Deferred tools pool �?keyed by name, created but not in `tools`.
   * When the model calls `tool_search` and discovers a tool, the agent
   * loop activates it by moving it from this pool into `tools` for the
   * next step.
   */
  deferredToolPool?: Record<string, AnyTool>
  /**
   * Resolves a tool definition by name for dual-channel result mapping.
   * Needed for defs built per turn (ToolSearch) that the registry never sees;
   * defaults to a registry-only lookup when omitted.
   */
  getToolDefinition?: (name: string) => ToolDefinition | undefined
  /**
   * Main-agent filesystem / tool permission gate. Forked agents pass a
   * tighter gate of their own; omitted → allow-all in the streaming executor.
   */
  canUseTool?: import('./can-use-tool.js').CanUseToolFn
  /**
   * Per-tool concurrency policy for manual tool orchestration. When omitted,
   * all tools run serially (safe default).
   */
  concurrencyPolicy?: ConcurrencyPolicyFn
  /** Persists large tool outputs; inherited by subagent runs. */
  sessionId?: string
  /** Request-scoped context for getAttachmentMessages. */
  toolUseContext?: ToolUseContext
  /**
   * Rebuild the active tool set when permission mode changes mid-turn
   * (e.g. ExitPlanMode approval unlocks Write/Bash after planning).
   */
  refreshTools?: () => Record<string, AnyTool>
  /** Rebuild system prompt when permission mode changes mid-turn. */
  refreshSystemPrompt?: () => string | Promise<string>
  /** Inject plan-exit reminders when transitioning out of plan mode mid-turn. */
  onPermissionModeChange?: () => Message[]
  /**
   * Called with boundary/summary/attachment events appended by a
   * session-memory or full compact. The in-memory transcript is never
   * replaced. Not invoked for microcompact (API-view only).
   */
  onFullCompaction?: (messages: readonly Message[]) => void
  /**
   * After each completed step (stream + tools). Host may fire session-memory
   * extract; the loop never awaits this.
   */
  onAfterStep?: (ctx: AgentLifecycleSnapshot) => void
  /**
   * Successfully finalized turn (natural completion or max-step final
   * response). Host may fire auto-memory extract; the loop never awaits this.
   * Aborted/error turns remain behind the extraction cursor.
   */
  onTurnEnd?: (ctx: AgentLifecycleSnapshot) => void
  /**
   * When aborted, the agent loop stops between / during LLM steps and
   * returns whatever partial text it has. Used by per-subagent Stop.
   */
  abortSignal?: AbortSignal
  /**
   * Optional prefix for agent console logs (e.g. `session_memory` →
   * `[agent:session_memory] step …`). Defaults to `main` when omitted so
   * forked agents are always distinguishable from the primary loop.
   */
  logLabel?: string
}

/** Snapshot passed to turn-host lifecycle hooks from runAgent. */
export interface AgentLifecycleSnapshot {
  messages: Message[]
  systemPrompt: string
  tools: Record<string, AnyTool>
  provider: IProvider
  model: string
  sessionId?: string
  cwd?: string
}

export type RunAgentFn = (
  userMessage: string,
  options: AgentOptions,
) => Promise<string>

// ── LLM provider ─────────────────────────────────
// Profile/strategy types live in `./llm/`. Re-exported here for convenience.

export type {
  LlmProfile,
  ProviderId,
  ThinkingConfig,
  IProvider,
  AgentStreamTextExtras,
  ProviderStrategy,
} from './llm/types.js'

// ── Plugin ──────────────────────────────────────

export interface PluginContext {
  tools: IToolRegistry
  events: IEventBus
  middleware: IMiddleware
}

export interface Plugin {
  name: string
  version?: string
  description?: string
  init(context: PluginContext): void | Promise<void>
  destroy?(): void | Promise<void>
}

// ── Session ─────────────────────────────────────

export interface Session {
  id: string
  messages: Message[]
  createdAt: number
  /**
   * LLM-generated session title (small-model side channel). When unset, UI
   * falls back to a heuristic preview of the first user message.
   */
  title?: string
  /**
   * Email of the user who created the session (SSO mode only). Used to keep
   * sessions private per-user. Undefined for sessions created without auth.
   */
  ownerEmail?: string
  /** Tool names discovered via `tool_search` �?activated in subsequent turns. */
  discoveredTools?: Set<string>
  /** Tracks files read for @-mention dedup + Read tool_unchanged (mtime-based). */
  readFileState?: import('../utils/read/types.js').ReadFileState
  /** Session-level Agent / Ask / Plan mode. */
  permissionMode: PermissionModeContext
  /**
   * Main-thread agent profile (`mode: primary` agentType), or null for the
   * default agent prompt. Independent of `permissionMode`.
   */
  agentType: string | null
  /** Set when exiting plan �?triggers reentry attachment on next plan entry. */
  hasExitedPlanMode?: boolean
  /** One-shot attachment after plan exit allowing execution. */
  needsPlanModeExitAttachment?: boolean
  /**
   * Bound execution workspace: which Environment + cwd tools run against.
   * Local is also a WorkspaceHandle (`environmentId: "local"`).
   */
  workspace?: import('../execution/types.js').WorkspaceHandle
  /**
   * Session “Always allow” directories.
   * Later Reads/Writes under these trees auto-allow for this session.
   */
  additionalWorkingDirectories?: string[]
  /**
   * Inline skills invoked this session. Not written as its
   * own jsonl event — durable copy is the post-compact `invoked_skills`
   * attachment, restored on getSession.
   */
  invokedSkills?: Map<
    string,
    import('../skills/invoked-skills.js').InvokedSkillInfo
  >
  /**
   * skill_listing is fire-once and survives compact so the
   * catalog is not re-injected after summarization.
   */
  skillListingAnnounced?: boolean
}

export interface SessionInfo {
  id: string
  createdAt?: number
  messageCount: number
  preview?: string
  permissionMode?: ExternalMode
  /** Main-thread primary agent profile, if any. */
  agentType?: string | null
  /** Present when SSO mode records session ownership (shown to super users). */
  ownerEmail?: string
}

// ── Server ──────────────────────────────────────

export interface ServerOptions {
  runAgent?: RunAgentFn
}

export interface RouterOptions {
  runAgent?: RunAgentFn
  staticDir: string | null
}

export interface SSETransport {
  emit(msg: import('../../protocol/src/wire.js').OutgoingMessage): void
  end(): void
}

// ── Subagent ────────────────────────────────────

export type AgentSource = 'built-in' | 'plugin' | 'user' | 'project' | 'managed'

/** Whether a disk agent is a ModePicker primary or AgentTool-only subagent. */
export type AgentMode = 'primary' | 'subagent'

/** Persistent Agent Memory scope. */
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * `shared` — this agent reads and writes the project-wide auto memory.
 * `private` — this agent gets its own memdir and never touches the shared one.
 */
export type MemoryPolicyMode = 'shared' | 'private'

/**
 * Which memory-type vocabulary the guide uses. `external` suits agents that
 * drive a system they do not edit (browser consoles, dashboards).
 */
export type MemoryVocabulary = 'coding' | 'external'

/**
 * Normalized memory configuration for one agent. Both frontmatter surfaces
 * (`memory: project` and `memory: { mode, scope, vocabulary }`) collapse into
 * this, and it is the only input the binding resolver reads.
 */
export interface MemoryPolicy {
  mode: MemoryPolicyMode
  /** Meaningful when `mode === 'private'`. */
  scope: AgentMemoryScope
  vocabulary: MemoryVocabulary
}

/**
 * Pure-data definition of a subagent / primary profile. After the single-Task
 * architecture refactor, subagents are entries in the `task` tool directory.
 * Primary agents (`mode: primary`) can also drive the main-thread prompt.
 */
export interface AgentDefinition {
  /** Stable identifier shown to the model as `subagent_type` value. */
  agentType: string
  /**
   * One-paragraph description rendered in the `task` tool's description
   * directory. Should include 1-3 user-phrasing examples in quotes so the
   * model recognizes triggers like "how does X work" / "audit Y".
   *
   * Add the literal string "use proactively" here to opt this agent into
   * the proactive-use protocol surfaced in the main system prompt.
   */
  whenToUse: string
  /** Brief description for activity logs / UI / events. */
  description: string
  /** System prompt the subagent (or main-thread profile) runs with. */
  systemPrompt: string
  /**
   * Allow-list of tool names. Mutually exclusive with `disallowedTools`.
   * If neither set, subagent inherits the full registry + MCP tools.
   */
  tools?: string[]
  /**
   * Deny-list of tool names. Entries may be exact names or suffix globs
   * (e.g. `search-memory_*`) for MCP isolation on the main thread.
   */
  disallowedTools?: string[]
  /**
   * `primary` — selectable as main-thread profile (ModePicker Specialists).
   * `subagent` or omitted — AgentTool only (default for built-ins / disk).
   */
  mode?: AgentMode
  /**
   * Optional step budget. Built-ins omit this; custom agents
   * may set it via frontmatter `maxSteps:`.
   */
  maxSteps?: number
  /** Optional model id override on the resolved tier's provider. */
  model?: string
  /**
   * Which configured tier to run on (static routing by call site).
   * Default when unset: `large`. Explore uses `small`.
   */
  modelTier?: ModelTier
  /** Display label used in the UI's SubagentCard. Defaults to titlecased agentType. */
  label?: string
  /**
   * Skip injecting project rules (AGENTS.md / .ai-agent/rules/*)
   * into this subagent's system prompt. Set true for fast read-only
   * exploration agents — the rules carry commit/PR/lint guidance the
   * subagent will never act on, and the parent already interprets results
   * with full context.
   */
  omitProjectRules?: boolean
  /**
   * Persistent Agent Memory scope (short form). Set for subagents
   * with a private memdir; AgentTool spawn reads this directly.
   * Gated by AutoMemoryConfig.enabled at spawn / prefetch time.
   */
  memory?: AgentMemoryScope
  /**
   * Normalized memory policy for both primary and subagent. Derived from the
   * same `memory:` frontmatter key (short or object form). The binding
   * resolver reads only this.
   */
  memoryPolicy?: MemoryPolicy
  /** Set when a newer project snapshot exists for user-scope agent memory. */
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  /** Where this definition was loaded from (disk agents + plugins). */
  source?: AgentSource
  /** Absolute path to the defining `.md` file, when loaded from disk. */
  filePath?: string
}

export interface AgentDefinitionsResult {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  errors: Array<{ filePath: string; error: string }>
}

// ── MCP ─────────────────────────────────────────

export interface MCPServerStdio {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface MCPServerHTTP {
  url: string
  transport?: 'http' | 'sse'
  headers?: Record<string, string>
}

export type MCPServerConfig = MCPServerStdio | MCPServerHTTP

export interface MCPServerStatus {
  name: string
  status: 'connected' | 'error' | 'disconnected'
  tools: string[]
  error?: string
}

// ── Todo ────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

// ── App Config ──────────────────────────────────

export interface CompactionConfig {
  /** Master switch �?when false, proactive auto-compact is skipped (manual /compact still works). */
  enabled: boolean
  /** Model's context window size in tokens. Used to dynamically compute compact threshold. */
  contextWindow: number
  /** Number of most-recent tool results to keep verbatim during micro-compaction. */
  microCompactKeepRecent: number
  /** Max number of recently-read files to re-inject post-compact. */
  maxFilesToRestore: number
  /** Max tokens (estimated) per restored file. */
  maxTokensPerFile: number
  /** Total token budget for all restored files combined. */
  fileBudget: number
  /**
   * Model's max output tokens. The compaction reserve is `min(this, 20_000)`.
   * When unset, the reserve defaults to 20_000.
   */
  maxOutputTokens?: number
  /**
   * Time-based micro-compaction. When the gap since the last assistant message
   * exceeds the TTL, the prompt cache is cold and the prefix will be rewritten
   * anyway �?so clearing old tool payloads first (content-mutating micro) is
   * "free". Default off.
   */
  timeBasedMicroEnabled?: boolean
  /**
   * Gap in minutes that marks the cache as cold. Set to match your prompt-cache
   * TTL: 5 for the default 5-min ephemeral cache, 60 for 1h TTL. Default 5.
   */
  timeBasedMicroGapMinutes?: number
}

/** Background session notes used to accelerate compaction. */
export interface SessionMemoryConfig {
  /** Master switch. Also requires compaction.enabled for auto extract. */
  enabled: boolean
  minimumTokensToInit: number
  minimumTokensBetweenUpdate: number
  toolCallsBetweenUpdates: number
  /**
   * When true (default), extract reuses the main-loop model + system +
   * full tools schema (`CacheSafeParams`) so the fork can hit prompt cache.
   * `canUseTool` still allows only Edit on summary.md.
   * When false, uses a restricted Edit-only fork on `modelTier`.
   */
  cacheSafe: boolean
  /**
   * Model tier for non-cacheSafe (restricted) extract.
   * Ignored when `cacheSafe` is true (main-loop model is used).
   */
  modelTier: 'large' | 'medium' | 'small'
  compactMinTokens: number
  compactMaxTokens: number
  compactMinTextMessages: number
}

/**
 * Runtime auto-memory config (derived from AppConfig + code defaults).
 *
 * Preferred nested surface under `autoMemory`:
 *   - `enabled`, `directory` (trusted scopes), `cacheSafe`, `modelTier`
 * Flat compatibility aliases still accepted:
 *   - `autoMemoryEnabled`, `autoMemoryDirectory`
 * Legacy flat agent aliases: `autoMemoryCacheSafe` / `autoMemoryModelTier`.
 */
export interface AutoMemoryConfig {
  enabled: boolean
  /** Trusted directory; from env / user / local only. */
  directory?: string
  /** Eligible turn-end extracts; default 1. */
  extractEveryNTurns: number
  /**
   * When true (default), reuse main-loop model via CacheSafeParams.
   * When false, use `modelTier` (default medium) with a matching provider.
   */
  cacheSafe: boolean
  /**
   * Model tier for non-cacheSafe extract. Ignored when `cacheSafe` is true.
   * Default medium when omitted.
   */
  modelTier?: ModelTier
  /**
   * When true (default), prefetch relevant topic memories each turn and do
   * not inject MEMORY.md into the system prompt.
   */
  prefetchEnabled: boolean
  /** Selector model tier; default small. */
  prefetchModelTier: ModelTier
}

export interface AppConfig {
  /** Three-tier profiles; medium/small fall back to large when omitted in settings. */
  models: ModelProfiles
  compaction: CompactionConfig
  sessionMemory: SessionMemoryConfig
  /**
   * Enable auto-memory. Flat compatibility key (`autoMemoryEnabled`).
   * Prefer nested `autoMemory.enabled` in settings.json.
   */
  autoMemoryEnabled: boolean
  /**
   * Custom auto-memory directory. Flat compatibility key (`autoMemoryDirectory`).
   * Trusted scopes only: user / local settings — never project settings.
   * Prefer nested `autoMemory.directory`.
   */
  autoMemoryDirectory?: string
  /**
   * Agent extension: when false, extract uses `autoMemoryModelTier`.
   * Prefer settings nested `autoMemory.cacheSafe`.
   * Flat `autoMemoryCacheSafe` kept for backward compatibility.
   */
  autoMemoryCacheSafe?: boolean
  /**
   * Agent extension: tier for non-cacheSafe extract. Default medium.
   * Prefer settings nested `autoMemory.modelTier`.
   * Flat `autoMemoryModelTier` kept for backward compatibility.
   */
  autoMemoryModelTier?: ModelTier
  /**
   * Nested auto-memory settings (prefetch, cacheSafe, …).
   * Flat keys still win when set; nested fills the rest.
   */
  autoMemory?: {
    enabled?: boolean
    directory?: string
    cacheSafe?: boolean
    modelTier?: ModelTier
    prefetchEnabled?: boolean
    prefetchModelTier?: ModelTier
  }
  mcpServers: Record<string, MCPServerConfig>
  lspServers: Record<string, LspServerConfig>
  /** Tool names to hide from the model (local or MCP, e.g. `web_fetch`, `someServer_fetch`) */
  disabledTools?: string[]
  /** Browser automation (`browser_*` tools). See src/browser/types.ts. */
  browser?: import('../browser/types.js').BrowserConfig
  /**
   * In-process cron scheduler (HTTP/Electron). When `enabled` is false,
   * tools are hidden and due tasks do not fire. Omitted = enabled.
   */
  scheduledTasks?: {
    enabled?: boolean
  }
  /**
   * Trusted remote extension catalogs. Project/local settings are not allowed
   * to supply these URLs because the agent server fetches them directly.
   */
  marketplaces?: {
    providers: MarketplaceProviderConfig[]
  }
  /**
   * ModePicker visibility + new-session defaults for permission modes and
   * primary agent profiles. See agents.picker / agents.default in settings.
   */
  agents?: {
    picker?: {
      /** Omit = all three modes; [] = hide mode rows. */
      modes?: Array<'agent' | 'ask' | 'plan'>
      /** Omit = all primary agents; [] = no specialists. */
      primaries?: string[]
    }
    default?: {
      mode?: 'agent' | 'ask' | 'plan'
      /** null = default coding (no specialist). */
      agentType?: string | null
    }
  }
  /**
   * Filesystem permission rules.
   * `additionalDirectories` / `allow` are desktop Always-allow; SSO ignores them.
   * `deny` always applies and wins over allow / working dirs.
   */
  permissions?: {
    additionalDirectories?: string[]
    allow?: string[]
    deny?: string[]
    /** Filesystem `permissions.defaultMode` (implemented subset). */
    defaultMode?: 'default' | 'dontAsk' | 'bypassPermissions'
  }
  /**
   * Extra SSH hosts for the execution EnvironmentRegistry (merged with ~/.ssh/config).
   */
  environments?: {
    ssh?: Array<{
      id?: string
      name?: string
      sshHost: string
      sshUser?: string
      sshPort?: number
      sshIdentityFile?: string
      proxyJump?: string
      startDirectory?: string
    }>
  }
}

export type { ModelProfiles, ModelRegistry, ModelTier }

export type MarketplaceProviderType = 'demeter' | 'skills-sh'
export type MarketplaceCapability = 'skills' | 'agents' | 'bundles'
export type MarketplaceAuthMode = 'none' | 'cookie-proxy'

export interface MarketplaceProviderConfig {
  id: string
  type: MarketplaceProviderType
  baseURL: string
  label?: string
  enabled?: boolean
  auth?: MarketplaceAuthMode
  capabilities?: MarketplaceCapability[]
  allowInsecureHttp?: boolean
  timeoutMs?: number
  maxDownloadBytes?: number
  maxExtractBytes?: number
  maxFiles?: number
}

export interface LspServerConfig {
  command: string
  args?: string[]
  extensionToLanguage?: Record<string, string>
  env?: Record<string, string>
  initializationOptions?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  maxRestarts?: number
}
