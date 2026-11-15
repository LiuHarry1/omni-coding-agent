import { randomUUID } from 'crypto'
import type {
  AgentContext,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ControlRequest } from '../../protocol/src/control.js'
import type { ServerMessage, SystemNotice } from '../../protocol/src/server.js'
import type { OutgoingMessage } from '../../protocol/src/wire.js'
import type { ProtocolSink } from '../core/protocol-sink.js'
import {
  controlRequestToNotifications,
  handleControlRequest,
} from './permission-bridge.js'
import { toolInfoFromCall } from './tool-kind.js'

type WireOutbound = OutgoingMessage | ControlRequest

export class AcpTurnSink implements ProtocolSink {
  readonly #client: AgentContext
  readonly #sessionId: string
  readonly #cwd: string
  readonly #messageId: string
  readonly #emittedToolCalls = new Set<string>()
  #turnDone = false

  constructor(client: AgentContext, sessionId: string, cwd: string) {
    this.#client = client
    this.#sessionId = sessionId
    this.#cwd = cwd
    this.#messageId = randomUUID()
  }

  emit(msg: WireOutbound): void {
    if (this.#turnDone) return

    if (msg.type === 'control_request') {
      for (const n of controlRequestToNotifications(this.#sessionId, msg)) {
        void this.#notify(n)
      }
      void handleControlRequest(this.#client, this.#sessionId, msg).catch(
        err => {
          console.error(
            '[acp] permission bridge failed:',
            (err as Error).message,
          )
        },
      )
      return
    }

    if (msg.type === 'control_response') return

    const notifications = serverMessageToNotifications(
      msg,
      this.#sessionId,
      this.#cwd,
      this.#messageId,
      this.#emittedToolCalls,
    )
    for (const n of notifications) {
      void this.#notify(n)
    }
  }

  markTurnDone(): void {
    this.#turnDone = true
  }

  async emitInitHandshake(cwd: string, permissionMode: string): Promise<void> {
    await this.#notify({
      sessionId: this.#sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          protocol_version: PROTOCOL_VERSION,
          permission_mode: permissionMode,
          cwd,
        },
      },
    })
  }

  async #notify(notification: SessionNotification): Promise<void> {
    await this.#client.notify(methods.client.session.update, notification)
  }
}

function serverMessageToNotifications(
  msg: ServerMessage,
  sessionId: string,
  cwd: string,
  messageId: string,
  emittedToolCalls: Set<string>,
): SessionNotification[] {
  const out: SessionNotification[] = []

  if (msg.type === 'stream_event') {
    if (msg.delta.kind === 'text') {
      out.push(
        chunkNotification(
          sessionId,
          'agent_message_chunk',
          messageId,
          msg.delta.text,
        ),
      )
    } else if (msg.delta.kind === 'reasoning') {
      out.push(
        chunkNotification(
          sessionId,
          'agent_thought_chunk',
          messageId,
          msg.delta.text,
        ),
      )
    }
    return out
  }

  if (msg.type === 'tool_call') {
    const info = toolInfoFromCall(msg.name, msg.args, cwd)
    if (emittedToolCalls.has(msg.tool_use_id)) {
      out.push({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: msg.tool_use_id,
          status: 'pending',
          title: info.title,
          kind: info.kind,
          rawInput: msg.args,
        },
      })
    } else {
      emittedToolCalls.add(msg.tool_use_id)
      out.push({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: msg.tool_use_id,
          title: info.title,
          kind: info.kind,
          status: 'pending',
          locations: info.locations,
          rawInput: msg.args,
        },
      })
    }
    return out
  }

  if (msg.type === 'tool_result') {
    out.push({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: msg.tool_use_id,
        status: msg.is_error ? 'failed' : 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: msg.result },
          },
        ],
        rawOutput: {
          result: msg.result,
          is_error: msg.is_error ?? false,
          ...(msg.tool_use_result !== undefined
            ? { tool_use_result: msg.tool_use_result }
            : {}),
        },
      },
    })
    return out
  }

  if (msg.type === 'tool_progress') {
    out.push({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: msg.tool_use_id,
        status: 'in_progress',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: msg.output },
          },
        ],
      },
    })
    return out
  }

  if (msg.type === 'system' && msg.subtype === 'todo_update') {
    out.push({
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: msg.todos
          .filter(t => t.status !== 'cancelled')
          .map(t => ({
            content: t.content,
            priority: (t.status === 'in_progress' ? 'high' : 'medium') as
              'high' | 'medium' | 'low',
            status:
              t.status === 'completed'
                ? ('completed' as const)
                : t.status === 'in_progress'
                  ? ('in_progress' as const)
                  : ('pending' as const),
          })),
      },
    })
    return out
  }

  if (msg.type === 'system' && msg.subtype === 'mode_changed') {
    out.push({
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: msg.mode,
      },
    })
    return out
  }

  if (msg.type === 'system' && msg.subtype === 'notice') {
    out.push(
      chunkNotification(
        sessionId,
        'agent_thought_chunk',
        messageId,
        `${noticeText(msg.notice)}\n`,
      ),
    )
    return out
  }

  if (msg.type === 'result' && msg.subtype === 'error') {
    out.push(
      chunkNotification(sessionId, 'agent_message_chunk', messageId, msg.error),
    )
  }

  return out
}

/** One line for clients that only show text. */
export function noticeText(notice: SystemNotice): string {
  switch (notice.kind) {
    case 'retry':
      return `Request failed, retrying in ${Math.ceil(notice.delay_ms / 1000)}s (attempt ${notice.attempt}/${notice.max_attempts}): ${notice.error}`
    case 'model_fallback':
      return `${notice.from} is overloaded; switched to ${notice.to}`
    case 'context_warning':
      return `Context left: ${notice.percent_left}% before older messages are summarized`
    case 'context_blocked':
      return `The conversation (~${notice.current_tokens} tokens) no longer fits the context (limit ${notice.blocking_limit})`
    case 'compaction_error':
      return `Summarizing the conversation failed: ${notice.error}`
  }
}

function chunkNotification(
  sessionId: string,
  sessionUpdate: SessionUpdate['sessionUpdate'],
  messageId: string,
  text: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate,
      messageId,
      content: { type: 'text', text },
    } as SessionUpdate,
  }
}

export function createAcpTransport(sink: AcpTurnSink): {
  emit(msg: WireOutbound): void
  end(): void
} {
  return {
    emit(msg) {
      sink.emit(msg)
    },
    end() {},
  }
}
