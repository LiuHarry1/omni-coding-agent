/**
 * Wire types mirrored from `src/server/skills-api.ts`
 * and `src/server/router.ts`. Kept narrow on purpose —
 * callers shouldn't have to import server-internal types just to talk
 * to the API. If the server adds fields, we add them here; nothing
 * here should reference server modules.
 */

export type SkillContextMode = 'inline' | 'fork'
export type SkillSource = 'built-in' | 'user' | 'project'

export interface SkillSummary {
  name: string
  description: string
  context: SkillContextMode
  agent?: string
  argumentNames: string[]
  paths?: string[]
  source: SkillSource
  filePath?: string
  baseDir?: string
  /** True iff the skill is unconditionally active (no `paths:` filter). */
  active: boolean
}

export interface AgentSummary {
  agentType: string
  whenToUse: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  maxSteps?: number
  model?: string
  mode?: 'primary' | 'subagent'
  label?: string
  source?: string
  filePath?: string
}

export interface AgentPickerResponse {
  modes: Array<'agent' | 'ask' | 'plan'>
  primaries: AgentSummary[]
  default: {
    mode: 'agent' | 'ask' | 'plan'
    agentType: string | null
  }
}

export interface SkillsListResponse {
  workspace: string
  skills: SkillSummary[]
  errors: Array<{ filePath: string; error: string }>
}

export interface AgentsListResponse {
  workspace: string
  agents: AgentSummary[]
  all?: AgentSummary[]
  sourceGroups?: string[]
  builtin: string[]
  picker?: AgentPickerResponse
  errors: Array<{ filePath: string; error: string }>
}

export interface SkillInvokeRequest {
  /** Absolute path to the workspace the skill should run against. */
  workspace?: string
  /**
   * Skill arguments. Either a raw string (`"audience=eng-team --strict"`,
   * same shape `$1` / `$ARGUMENTS` would see) or a structured object
   * (`{ audience: "eng-team", strict: true }`). The server flattens
   * objects to `key=value` pairs with shell-style quoting before
   * substitution, so `$name` resolution works either way.
   */
  arguments?: string | Record<string, string | number | boolean>
  /**
   * Only meaningful for `context: "fork"` skills. When `false`, the
   * server buffers the subagent's final text and returns one JSON blob
   * instead of an SSE stream. Inline skills always return JSON.
   */
  stream?: boolean
}

export interface SkillInvokeInlineResult {
  skill: string
  context: 'inline'
  workspace: string
  result: string
}

export interface SkillInvokeForkResult {
  skill: string
  context: 'fork'
  agentType: string
  workspace: string
  result: string
}

export type SkillInvokeResult = SkillInvokeInlineResult | SkillInvokeForkResult

export interface ChatRequest {
  message: string
  workspace?: string
  session_id?: string
  images?: string[]
  /** Permission mode: agent | ask | plan. */
  mode?: string
  /** Primary agent profile id (null/omit = default Agent). */
  agentType?: string | null
  /** Execution-plane environment (local | remote id). */
  environmentId?: string
  /** Same semantics as `SkillInvokeRequest.stream`. */
  stream?: boolean
}

export interface ChatJSONResult {
  session_id: string
  run_id?: string
  text: string
  messages?: unknown[]
  /** Present when the server short-circuited via a built-in slash command. */
  reason?: string
}

/**
 * Protocol messages emitted by `/chat` and fork skill SSE streams.
 * Shape matches `@ai-agent/protocol` OutgoingMessage JSON on the wire.
 */
export type AgentEvent = Record<string, unknown> & {
  type: string
  /** SSE id used to resume a durable run stream. */
  event_id?: string
  /** Present on events opened through the SDK's streaming chat helper. */
  run_id?: string
}

export interface StartedChatRun {
  run_id: string
  session_id?: string
  events: AsyncIterable<AgentEvent>
}

export type DurableRunStatus =
  | 'creating'
  | 'running'
  | 'requires_action'
  | 'waiting_for_background_work'
  | 'recovering'
  | 'finished'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface DurableRun {
  version: 1
  runId: string
  sessionId: string
  status: DurableRunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  attempt: number
  lastSeq: number
  checkpointSeq: number
  finalText?: string
  reason?: string
  error?: string
}
