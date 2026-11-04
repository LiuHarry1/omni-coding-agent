import { z } from 'zod'
import {
  envelopeFields,
  PermissionModeSchema,
  TodoItemSchema,
  UsageSchema,
} from './common.js'
import { PROTOCOL_VERSION } from './version.js'
import { ControlRequestSchema } from './control.js'

/**
 * Messages flowing from the agent engine to a GUI / client.
 *
 * Shape of the SDK message union:
 *   - top-level discriminant is `type`
 *   - the `system` type carries a secondary `subtype` discriminant
 *     (init / todo_update / skill_start / mode_changed / …)
 *   - the union itself is a plain `z.union` (not discriminatedUnion)
 *     precisely because several members share `type: "system"`.
 *
 * The engine emits these regardless of transport; SSE / NDJSON / ACP
 * adapters just serialize them differently.
 */

// ── Handshake ────────────────────────────────────────
// First message of a session. Announces protocol version + capabilities,
// like `system/init`. Fields the engine can't know yet are optional.
export const InitMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  protocol_version: z.literal(PROTOCOL_VERSION),
  permission_mode: PermissionModeSchema,
  cwd: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  ...envelopeFields,
})

// ── Streaming assistant output ───────────────────────
// Incremental deltas (`stream_event` / partial assistant). `kind`
// separates visible answer text from chain-of-thought reasoning.
export const StreamEventMessageSchema = z.object({
  type: z.literal('stream_event'),
  delta: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({ kind: z.literal('reasoning'), text: z.string() }),
  ]),
  ...envelopeFields,
})

// A settled assistant message (`assistant`). `content` is left as
// unknown for now — it carries the provider message shape verbatim.
export const AssistantMessageSchema = z.object({
  type: z.literal('assistant'),
  content: z.unknown(),
  ...envelopeFields,
})

// ── Tool activity ────────────────────────────────────
export const ToolCallMessageSchema = z.object({
  type: z.literal('tool_call'),
  tool_use_id: z.string(),
  name: z.string(),
  args: z.unknown(),
  is_subagent: z.boolean().optional(),
  ...envelopeFields,
})

export const ToolResultMessageSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  result: z.string(),
  /** CC-style structured tool Output for UI (not sent to the model). */
  tool_use_result: z.unknown().optional(),
  is_error: z.boolean().optional(),
  ...envelopeFields,
})

// ── system/<subtype> progress events ─────────────────
export const TodoUpdateMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('todo_update'),
  todos: z.array(TodoItemSchema),
  ...envelopeFields,
})

export const SkillStartMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('skill_start'),
  skill: z.string(),
  agent_type: z.string().optional(),
  workspace: z.string().optional(),
  ...envelopeFields,
})

export const ModeChangedMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('mode_changed'),
  mode: PermissionModeSchema,
  ...envelopeFields,
})

// ── Terminal result ──────────────────────────────────
// Ends a turn (`result`, split into success / error variants).
export const ResultSuccessMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
  reason: z.string(),
  text: z.string().optional(),
  usage: UsageSchema.optional(),
  ...envelopeFields,
})

export const ResultErrorMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.literal('error'),
  error: z.string(),
  ...envelopeFields,
})

// ── GUI progress extensions (engine → client, Web UI parity) ──
// Kept off the public SDK stream; exposed for the web UI.

export const ReasoningStartMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('reasoning_start'),
  ...envelopeFields,
})

export const ReasoningEndMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('reasoning_end'),
  ...envelopeFields,
})

export const ToolInputStartMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('tool_input_start'),
  tool_use_id: z.string(),
  name: z.string(),
  is_subagent: z.boolean().optional(),
  ...envelopeFields,
})

export const ToolInputDeltaMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('tool_input_delta'),
  tool_use_id: z.string(),
  bytes: z.number(),
  ...envelopeFields,
})

export const ToolInputPreviewDeltaMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('tool_input_preview_delta'),
  tool_use_id: z.string(),
  delta: z.string(),
  ...envelopeFields,
})

export const StepStartMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('step_start'),
  step: z.number(),
  task: z.string().optional(),
  label: z.string().optional(),
  ...envelopeFields,
})

export const ThinkingMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('thinking'),
  ...envelopeFields,
})

export const TurnStateMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('turn_state'),
  state: z.enum([
    'preparing',
    'requesting',
    'thinking',
    'responding',
    'tool-input',
    'tool-use',
    'idle',
  ]),
  detail_code: z.string().max(80).optional(),
  label: z.string().max(160).optional(),
  ...envelopeFields,
})

export const PlanReadyMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('plan_ready'),
  plan: z.string(),
  file_path: z.string().optional(),
  approved: z.boolean().optional(),
  ...envelopeFields,
})

export const CompactionStartMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compaction_start'),
  messages_before: z.number().optional(),
  tokens_before: z.number().optional(),
  ...envelopeFields,
})

export const CompactionDoneMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compaction_done'),
  /**
   * How the compaction attempt ended. Every compaction_start is guaranteed
   * a matching compaction_done so clients can settle their progress UI:
   *   ok    — history was summarized (default when absent)
   *   noop  — summarizer produced no change, nothing was rewritten
   *   error — summarization failed, conversation left untouched
   */
  status: z.enum(['ok', 'noop', 'error']).optional(),
  messages_after: z.number().optional(),
  tokens_after: z.number().optional(),
  ...envelopeFields,
})

export const ToolTimingMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('tool_timing'),
  name: z.string(),
  duration: z.number(),
  /** Correlates timing to a specific tool_call when multiple share `name`. */
  tool_use_id: z.string().optional(),
  ...envelopeFields,
})

/** User stopped the turn (CC Esc) — transcript also has the interrupt user msg. */
export const InterruptedMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('interrupted'),
  tool_use: z.boolean().optional(),
  text: z.string().optional(),
  ...envelopeFields,
})

/** A scheduled-task fire is about to run in this session (no local composer submit). */
export const ScheduledTurnMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('scheduled_turn'),
  prompt: z.string(),
  ...envelopeFields,
})

/** Live shell/process output (`tool_progress`). */
export const ToolProgressMessageSchema = z.object({
  type: z.literal('tool_progress'),
  tool_use_id: z.string(),
  tool_name: z.string(),
  output: z.string(),
  ...envelopeFields,
})

/**
 * Anything the engine emits that isn't (yet) part of the stable public
 * contract — internal progress like compaction, token usage, tool-input
 * previews. Kept as an explicit escape hatch so additive engine changes
 * never crash a GUI while still being forward-compatible.
 */
export const KeepAliveMessageSchema = z.object({
  type: z.literal('keep_alive'),
})

export const ServerMessageSchema = z.union([
  InitMessageSchema,
  StreamEventMessageSchema,
  AssistantMessageSchema,
  ToolCallMessageSchema,
  ToolResultMessageSchema,
  TodoUpdateMessageSchema,
  SkillStartMessageSchema,
  ModeChangedMessageSchema,
  ResultSuccessMessageSchema,
  ResultErrorMessageSchema,
  ReasoningStartMessageSchema,
  ReasoningEndMessageSchema,
  ToolInputStartMessageSchema,
  ToolInputDeltaMessageSchema,
  ToolInputPreviewDeltaMessageSchema,
  StepStartMessageSchema,
  ThinkingMessageSchema,
  TurnStateMessageSchema,
  PlanReadyMessageSchema,
  CompactionStartMessageSchema,
  CompactionDoneMessageSchema,
  ToolTimingMessageSchema,
  InterruptedMessageSchema,
  ScheduledTurnMessageSchema,
  ToolProgressMessageSchema,
  // The engine can also reach back to the client (permission, plan, …).
  ControlRequestSchema,
  KeepAliveMessageSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
