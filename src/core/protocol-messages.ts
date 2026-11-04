import {
  PermissionModeSchema,
  type PermissionMode,
  type TodoItem,
} from '../../protocol/src/common.js'
import { PROTOCOL_VERSION } from '../../protocol/src/version.js'
import type { ServerMessage } from '../../protocol/src/server.js'
import type { ControlRequest } from '../../protocol/src/control.js'

export function buildInitMessage(input: {
  session_id: string
  permission_mode: string
  cwd?: string
  model?: string
  tools?: string[]
}): ServerMessage {
  const mode = PermissionModeSchema.safeParse(input.permission_mode)
  return {
    type: 'system',
    subtype: 'init',
    protocol_version: PROTOCOL_VERSION,
    permission_mode: mode.success ? mode.data : 'agent',
    session_id: input.session_id,
    cwd: input.cwd,
    model: input.model,
    tools: input.tools,
  }
}

export function asPermissionMode(
  value: unknown,
  fallback: PermissionMode = 'agent',
): PermissionMode {
  const parsed = PermissionModeSchema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

export type WireEnvelope = {
  session_id: string
  parent_tool_use_id?: string
}

export type TurnState =
  | 'preparing'
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-input'
  | 'tool-use'
  | 'idle'

export function turnStateMessage(
  state: TurnState,
  input: { detail_code?: string; label?: string },
  env: WireEnvelope,
): ServerMessage {
  return {
    type: 'system',
    subtype: 'turn_state',
    state,
    detail_code: input.detail_code,
    label: input.label,
    ...env,
  }
}

export function scheduledTurnMessage(
  prompt: string,
  env: WireEnvelope,
): ServerMessage {
  return {
    type: 'system',
    subtype: 'scheduled_turn',
    prompt,
    ...env,
  }
}

export function modeChangedMessage(
  mode: string,
  env: WireEnvelope,
): ServerMessage {
  return {
    type: 'system',
    subtype: 'mode_changed',
    mode: asPermissionMode(mode),
    ...env,
  }
}

export function todoUpdateMessage(
  todos: TodoItem[],
  env: WireEnvelope,
): ServerMessage {
  return { type: 'system', subtype: 'todo_update', todos, ...env }
}

export function textDeltaMessage(
  text: string,
  env: WireEnvelope,
): ServerMessage {
  return {
    type: 'stream_event',
    delta: { kind: 'text', text },
    ...env,
  }
}

export function reasoningDeltaMessage(
  text: string,
  env: WireEnvelope,
): ServerMessage {
  return {
    type: 'stream_event',
    delta: { kind: 'reasoning', text },
    ...env,
  }
}

export function toolCallMessage(input: {
  tool_use_id: string
  name: string
  args: unknown
  is_subagent?: boolean
  env: WireEnvelope
}): ServerMessage {
  return {
    type: 'tool_call',
    tool_use_id: input.tool_use_id,
    name: input.name,
    args: input.args,
    ...input.env,
    ...(input.is_subagent ? { is_subagent: true } : {}),
  }
}

export function toolResultMessage(input: {
  tool_use_id: string
  result: string
  tool_use_result?: unknown
  is_error?: boolean
  env: WireEnvelope
}): ServerMessage {
  return {
    type: 'tool_result',
    tool_use_id: input.tool_use_id,
    result: input.result,
    ...(input.tool_use_result !== undefined
      ? { tool_use_result: input.tool_use_result }
      : {}),
    is_error: input.is_error,
    ...input.env,
  }
}

export function resultSuccessMessage(input: {
  reason: string
  text?: string
  env: WireEnvelope
}): ServerMessage {
  return {
    type: 'result',
    subtype: 'success',
    reason: input.reason,
    text: input.text,
    ...input.env,
  }
}

export function resultErrorMessage(
  error: string,
  env: WireEnvelope,
): ServerMessage {
  return { type: 'result', subtype: 'error', error, ...env }
}

export function skillStartMessage(input: {
  skill: string
  agent_type?: string
  workspace?: string
  env: WireEnvelope
}): ServerMessage {
  return {
    type: 'system',
    subtype: 'skill_start',
    skill: input.skill,
    agent_type: input.agent_type,
    workspace: input.workspace,
    ...input.env,
  }
}

export function askUserQuestionRequest(input: {
  request_id: string
  questions: unknown[]
}): ControlRequest {
  return {
    type: 'control_request',
    request_id: input.request_id,
    request: {
      subtype: 'ask_user_question',
      question_id: input.request_id,
      questions: input.questions,
    },
  }
}

export function canUseToolRequest(input: {
  request_id: string
  tool_name: string
  tool_use_id: string
  input: Record<string, unknown>
  title?: string
  description?: string
}): ControlRequest {
  return {
    type: 'control_request',
    request_id: input.request_id,
    request: {
      subtype: 'can_use_tool',
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      input: input.input,
      title: input.title,
      description: input.description,
    },
  }
}

export function approvePlanRequest(input: {
  request_id: string
  plan: string
}): ControlRequest {
  return {
    type: 'control_request',
    request_id: input.request_id,
    request: {
      subtype: 'approve_plan',
      request_id: input.request_id,
      plan: input.plan,
    },
  }
}

export function interruptedMessage(
  input: { tool_use?: boolean; text?: string },
  env: WireEnvelope,
): ServerMessage {
  return {
    type: 'system',
    subtype: 'interrupted',
    tool_use: input.tool_use,
    text: input.text,
    ...env,
  }
}
