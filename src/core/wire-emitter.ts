import type { TodoItem } from '../../protocol/src/common.js'
import type { OutgoingMessage } from '../../protocol/src/wire.js'
import type { ProtocolSink } from './protocol-sink.js'
import {
  approvePlanRequest,
  askUserQuestionRequest,
  canUseToolRequest,
  interruptedMessage,
  modeChangedMessage,
  reasoningDeltaMessage,
  resultErrorMessage,
  resultSuccessMessage,
  skillStartMessage,
  textDeltaMessage,
  todoUpdateMessage,
  toolCallMessage,
  toolResultMessage,
  turnStateMessage,
  type TurnState,
  type WireEnvelope,
} from './protocol-messages.js'

/**
 * Typed wire emitter ??
 * boundary instead of stringly eventBus pairs translated at transport time.
 */
export class WireEmitter {
  readonly #sink: ProtocolSink
  readonly #env: WireEnvelope
  #lastTurnState = ''

  constructor(sink: ProtocolSink, sessionId: string, parentToolUseId?: string) {
    this.#sink = sink
    this.#env = {
      session_id: sessionId,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }
  }

  scoped(parentToolUseId: string): WireEmitter {
    return new WireEmitter(this.#sink, this.#env.session_id, parentToolUseId)
  }

  emit(msg: OutgoingMessage): void {
    this.#sink.emit(msg)
  }

  textDelta(text: string): void {
    this.turnState('responding')
    this.emit(textDeltaMessage(text, this.#env))
  }

  reasoningStart(): void {
    this.turnState('thinking')
    this.emit({ type: 'system', subtype: 'reasoning_start', ...this.#env })
  }

  reasoningEnd(): void {
    this.emit({ type: 'system', subtype: 'reasoning_end', ...this.#env })
  }

  reasoningDelta(text: string): void {
    this.emit(reasoningDeltaMessage(text, this.#env))
  }

  toolInputStart(input: {
    tool_use_id: string
    name: string
    is_subagent?: boolean
  }): void {
    this.turnState('tool-input')
    this.emit({
      type: 'system',
      subtype: 'tool_input_start',
      tool_use_id: input.tool_use_id,
      name: input.name,
      is_subagent: input.is_subagent,
      ...this.#env,
    })
  }

  toolInputDelta(toolUseId: string, bytes: number): void {
    this.emit({
      type: 'system',
      subtype: 'tool_input_delta',
      tool_use_id: toolUseId,
      bytes,
      ...this.#env,
    })
  }

  toolInputPreviewDelta(toolUseId: string, delta: string): void {
    this.emit({
      type: 'system',
      subtype: 'tool_input_preview_delta',
      tool_use_id: toolUseId,
      delta,
      ...this.#env,
    })
  }

  toolCall(input: {
    tool_use_id: string
    name: string
    args: unknown
    is_subagent?: boolean
  }): void {
    this.turnState('tool-use')
    this.emit(
      toolCallMessage({
        tool_use_id: input.tool_use_id,
        name: input.name,
        args: input.args,
        is_subagent: input.is_subagent,
        env: this.#env,
      }),
    )
  }

  toolResult(input: {
    tool_use_id: string
    result: string
    tool_use_result?: unknown
    is_error?: boolean
  }): void {
    this.emit(
      toolResultMessage({
        tool_use_id: input.tool_use_id,
        result: input.result,
        tool_use_result: input.tool_use_result,
        is_error: input.is_error,
        env: this.#env,
      }),
    )
  }

  stepStart(step: number, extra?: { task?: string; label?: string }): void {
    this.emit({
      type: 'system',
      subtype: 'step_start',
      step,
      task: extra?.task,
      label: extra?.label,
      ...this.#env,
    })
  }

  thinking(): void {
    this.turnState('thinking')
    this.emit({ type: 'system', subtype: 'thinking', ...this.#env })
  }

  turnState(state: TurnState, detailCode?: string, label?: string): void {
    const key = `${state}\0${detailCode ?? ''}\0${label ?? ''}`
    if (key === this.#lastTurnState) return
    this.#lastTurnState = key
    this.emit(
      turnStateMessage(state, { detail_code: detailCode, label }, this.#env),
    )
  }

  todoUpdate(todos: TodoItem[]): void {
    this.emit(todoUpdateMessage(todos, this.#env))
  }

  modeChanged(mode: string): void {
    this.emit(modeChangedMessage(mode, this.#env))
  }

  planReady(input: {
    plan: string
    file_path?: string
    approved?: boolean
  }): void {
    this.emit({
      type: 'system',
      subtype: 'plan_ready',
      plan: input.plan,
      file_path: input.file_path,
      approved: input.approved,
      ...this.#env,
    })
  }

  planApprovalRequest(requestId: string, plan: string): void {
    this.emit(approvePlanRequest({ request_id: requestId, plan }))
  }

  askUserQuestion(requestId: string, questions: unknown[]): void {
    this.emit(askUserQuestionRequest({ request_id: requestId, questions }))
  }

  canUseTool(input: {
    request_id: string
    tool_name: string
    tool_use_id: string
    input: Record<string, unknown>
    title?: string
    description?: string
  }): void {
    this.emit(canUseToolRequest(input))
  }

  skillStart(input: {
    skill: string
    agent_type?: string
    workspace?: string
  }): void {
    this.emit(
      skillStartMessage({
        skill: input.skill,
        agent_type: input.agent_type,
        workspace: input.workspace,
        env: this.#env,
      }),
    )
  }

  compactionStart(data: {
    messages_before?: number
    tokens_before?: number
  }): void {
    this.emit({
      type: 'system',
      subtype: 'compaction_start',
      messages_before: data.messages_before,
      tokens_before: data.tokens_before,
      ...this.#env,
    })
  }

  compactionDone(data: {
    status?: 'ok' | 'noop' | 'error'
    messages_after?: number
    tokens_after?: number
  }): void {
    this.emit({
      type: 'system',
      subtype: 'compaction_done',
      status: data.status,
      messages_after: data.messages_after,
      tokens_after: data.tokens_after,
      ...this.#env,
    })
  }

  toolTiming(name: string, duration: number, toolUseId?: string): void {
    this.emit({
      type: 'system',
      subtype: 'tool_timing',
      name,
      duration,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      ...this.#env,
    })
  }

  processOutput(toolUseId: string, toolName: string, output: string): void {
    this.emit({
      type: 'tool_progress',
      tool_use_id: toolUseId,
      tool_name: toolName,
      output,
      ...this.#env,
    })
  }

  finish(reason: string, text?: string): void {
    this.turnState('idle')
    this.emit(resultSuccessMessage({ reason, text, env: this.#env }))
  }

  done(): void {
    this.turnState('idle')
    this.emit(resultSuccessMessage({ reason: 'done', env: this.#env }))
  }

  error(message: string): void {
    this.turnState('idle')
    this.emit(resultErrorMessage(message, this.#env))
  }

  /** Esc/Stop ? UI shows Interrupted; transcript has the user marker. */
  interrupted(input: { tool_use?: boolean; text?: string }): void {
    this.emit(interruptedMessage(input, this.#env))
  }
}

export function createWireEmitter(
  sink: ProtocolSink,
  sessionId: string,
): WireEmitter {
  return new WireEmitter(sink, sessionId)
}

export const noopWireEmitter = new WireEmitter({ emit() {} }, '')
