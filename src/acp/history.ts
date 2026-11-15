/**
 * Replay a saved conversation to an ACP client (`session/load`): the user's
 * messages, the agent's text and thinking, and each tool call with its result.
 */
import { randomUUID } from 'crypto'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { Message, ToolResultOutput } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import { isInterruptMessage } from '../utils/interrupt.js'
import { isSystemReminderContent } from '../utils/system-reminder.js'
import { toolInfoFromCall } from './tool-kind.js'

function outputText(output: ToolResultOutput): string {
  if (output.type === 'text') return output.value
  return output.value
    .map(part => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')
}

export function historyNotifications(
  sessionId: string,
  messages: readonly Message[],
  cwd: string,
): SessionNotification[] {
  const out: SessionNotification[] = []
  const chunk = (
    sessionUpdate:
      'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
    messageId: string,
    text: string,
  ) => {
    if (!text) return
    out.push({
      sessionId,
      update: { sessionUpdate, messageId, content: { type: 'text', text } },
    } as SessionNotification)
  }

  for (const message of messages) {
    if (!isRoleMessage(message)) continue
    const messageId = message.uuid ?? randomUUID()
    if (message.role === 'user') {
      // Written for the model, not typed by the user.
      if (
        message.isMeta ||
        message.isCompactSummary ||
        isInterruptMessage(message)
      ) {
        continue
      }
      const text =
        message.displayContent ??
        (typeof message.content === 'string'
          ? message.content
          : message.content
              .map(part => (part.type === 'text' ? part.text : ''))
              .join(''))
      if (!isSystemReminderContent(text)) {
        chunk('user_message_chunk', messageId, text)
      }
      continue
    }
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text') {
          chunk('agent_message_chunk', messageId, part.text)
        } else if (part.type === 'reasoning') {
          chunk('agent_thought_chunk', messageId, part.text)
        } else if (part.type === 'tool-call') {
          const info = toolInfoFromCall(part.toolName, part.input, cwd)
          out.push({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: part.toolCallId,
              title: info.title,
              kind: info.kind,
              status: 'pending',
              locations: info.locations,
              rawInput: part.input,
            },
          })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue
        const text = outputText(part.output)
        out.push({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: part.toolCallId,
            status: part.isError ? 'failed' : 'completed',
            content: [{ type: 'content', content: { type: 'text', text } }],
          },
        })
      }
    }
  }
  return out
}
