import type { Message, ToolResultOutput } from '../core/types.js'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import { isCompactBoundaryMessage } from '../core/messages/compact-boundary.js'
import { getSessionTranscriptPath } from '../session/index.js'
import { parseSessionJsonLine } from '../session/json-serialize.js'
import { replayTranscriptMessages } from '../session/compact-replay.js'
import { getSubagentNames } from '../tools/AgentTool/index.js'
import { defaultRegistry } from '../tools.js'
import { isScheduledPromptText } from '../services/cron/scheduled-prompt.js'
import { isSystemReminderContent } from '../utils/system-reminder.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isInterruptMessage,
} from '../utils/interrupt.js'
import { toolResultOutputToText } from '../utils/tool-result-content.js'
import { projectLegacyFatToolUseResult } from '../utils/project-tool-use-result.js'

const COMPACT_SUMMARY_PREFIX =
  '[Previous conversation compacted — context continues below]\n\n'
const COMPACT_SUMMARY_FOOTER =
  '\n\nContinue from where you left off without asking questions.'
const UI_RESULT_MAX_CHARS = 2_000

function truncateUiResult(text: string): string {
  if (text.length <= UI_RESULT_MAX_CHARS) return text
  return `${text.slice(0, UI_RESULT_MAX_CHARS - 1)}…`
}

function userMessageText(msg: Message): string {
  if (!isRoleMessage(msg) || msg.role !== 'user') return ''
  return typeof msg.content === 'string'
    ? msg.content
    : (msg.content as Array<{ type: string; text?: string }>)
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('')
}

/** Short upload URLs for the UI — never revive Buffer / data URLs into React. */
function userMessageImageUrls(msg: Message): string[] | undefined {
  if (!isRoleMessage(msg) || msg.role !== 'user') return undefined
  if (!Array.isArray(msg.content)) return undefined
  const urls: string[] = []
  for (const part of msg.content as Array<{
    type?: string
    image?: unknown
  }>) {
    if (part.type !== 'image') continue
    if (
      typeof part.image === 'string' &&
      part.image.startsWith('/sessions/') &&
      part.image.includes('/uploads/')
    ) {
      urls.push(part.image)
    }
  }
  return urls.length ? urls : undefined
}

/** compact summary is model-only; UI gets a boundary marker. */
function isCompactSummaryMessage(msg: Message): boolean {
  if (!isRoleMessage(msg) || msg.role !== 'user') return false
  if (msg.isCompactSummary) return true
  const text = userMessageText(msg)
  return text.startsWith(COMPACT_SUMMARY_PREFIX)
}

function extractCompactSummaryBody(content: string): string {
  if (!content.startsWith(COMPACT_SUMMARY_PREFIX)) return content
  let body = content.slice(COMPACT_SUMMARY_PREFIX.length)
  const footerIdx = body.indexOf(COMPACT_SUMMARY_FOOTER)
  if (footerIdx >= 0) body = body.slice(0, footerIdx)
  body = body.trim()
  const MAX_SUMMARY = 4_000
  if (body.length > MAX_SUMMARY) return `${body.slice(0, MAX_SUMMARY - 1)}…`
  return body
}

type UIPart = {
  type: string
  content?: string
  toolCallId?: string
  result?: string
  toolUseResult?: unknown
  isError?: boolean
  name?: string
  args?: unknown
  status?: string
  isSubagent?: boolean
}

type UIAssistantMessage = {
  type: 'assistant'
  id?: string
  parts: UIPart[]
  status: 'done'
}

export type UICompactBoundaryMessage = {
  type: 'compact_boundary'
  id?: string
  summary: string
  summaryLength: number
  messagesBefore?: number
}

/** Append one stored assistant message's displayable parts onto a UI turn. */
function appendAssistantParts(
  target: UIAssistantMessage,
  content: Array<{
    type: string
    text?: string
    toolCallId?: string
    toolName?: string
    input?: unknown
  }>,
  subagentNames: Set<string>,
): void {
  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      target.parts.push({ type: 'text', content: part.text })
    } else if (part.type === 'reasoning' && part.text?.trim()) {
      target.parts.push({
        type: 'reasoning',
        content: part.text,
        status: 'done',
      })
    } else if (part.type === 'tool-call') {
      target.parts.push({
        type: 'tool_call',
        name: part.toolName,
        toolCallId: part.toolCallId,
        args: part.input,
        status: 'done',
        isSubagent: subagentNames.has(part.toolName ?? ''),
      })
    }
  }
}

/**
 * Convert agent messages to flat UI format for the web client.
 *
 * One user turn can produce many stored assistant/tool messages (tool-call →
 * tool-result → tool-call …). While streaming, the frontend accumulates all of
 * those into a single assistant bubble; merge consecutive assistant parts here
 * so session reload matches that layout.
 *
 * isCompactSummary user messages become compact_boundary markers, not raw
 * user bubbles with the full summary text. isMeta user messages are dropped
 * — they are API-side injections, not chat turns (scheduled turns aside).
 */
export function sessionToUIMessages(messages: Message[]): unknown[] {
  const uiMessages: unknown[] = []
  const subagentNames = getSubagentNames(defaultRegistry)
  let currentAssistant: UIAssistantMessage | null = null
  let currentBoundary: UICompactBoundaryMessage | null = null

  for (const msg of messages) {
    if (isAttachmentMessage(msg)) continue
    if (isCompactBoundaryMessage(msg)) {
      currentAssistant = null
      currentBoundary = {
        type: 'compact_boundary',
        id: msg.uuid,
        summary: '',
        summaryLength: 0,
        messagesBefore: msg.compactMetadata.messagesSummarized,
      }
      uiMessages.push(currentBoundary)
      continue
    }
    if (isRoleMessage(msg) && msg.role === 'user') {
      const content = userMessageText(msg)
      // Meta user messages (inline skill bodies, attachment preludes, plan
      // follow-ups) are model-only. Streaming never emits a bubble for them,
      // so reload must not either — and the assistant turn they sit inside
      // stays one bubble, hence no `currentAssistant` reset here. Scheduled
      // turns are the exception: stored meta, but shown live and on reload.
      if (msg.isMeta && !isScheduledPromptText(content)) continue
      currentAssistant = null
      if (isSystemReminderContent(content)) continue
      if (isInterruptMessage(msg)) {
        uiMessages.push({
          type: 'interrupted',
          id: randomUUID(),
          toolUse: content === INTERRUPT_MESSAGE_FOR_TOOL_USE,
          text: content || INTERRUPT_MESSAGE,
        })
        continue
      }
      if (isCompactSummaryMessage(msg)) {
        const summary = extractCompactSummaryBody(content)
        if (currentBoundary) {
          currentBoundary.summary = summary
          currentBoundary.summaryLength = summary.length
        } else {
          uiMessages.push({
            type: 'compact_boundary',
            id: randomUUID(),
            summary,
            summaryLength: summary.length,
          } satisfies UICompactBoundaryMessage)
        }
        currentBoundary = null
        continue
      }
      currentBoundary = null
      const images = userMessageImageUrls(msg)
      uiMessages.push({
        type: 'user',
        id: randomUUID(),
        content,
        ...(images ? { images } : {}),
        ...(msg.files?.length ? { files: msg.files } : {}),
        ...(msg.turnStartTime != null && msg.turnEndTime != null
          ? { turnStartTime: msg.turnStartTime, turnEndTime: msg.turnEndTime }
          : {}),
      })
    } else if (isRoleMessage(msg) && msg.role === 'assistant') {
      currentBoundary = null
      if (!currentAssistant) {
        currentAssistant = {
          type: 'assistant',
          id: randomUUID(),
          parts: [],
          status: 'done',
        }
        uiMessages.push(currentAssistant)
      }
      appendAssistantParts(
        currentAssistant,
        msg.content as Array<{
          type: string
          text?: string
          toolCallId?: string
          toolName?: string
          input?: unknown
        }>,
        subagentNames,
      )
    } else if (isRoleMessage(msg) && msg.role === 'tool') {
      currentBoundary = null
      if (currentAssistant) {
        for (const tr of msg.content as Array<{
          type: string
          toolCallId: string
          toolName: string
          output?: ToolResultOutput
          toolUseResult?: unknown
          isError?: boolean
        }>) {
          const tc = currentAssistant.parts.find(
            p => p.type === 'tool_call' && p.toolCallId === tr.toolCallId,
          )
          if (tc) {
            tc.result = truncateUiResult(toolResultOutputToText(tr.output))
            if (tr.toolUseResult !== undefined) {
              tc.toolUseResult = projectLegacyFatToolUseResult(
                tr.toolName ?? tc.name,
                tr.toolUseResult,
              )
            }
            if (tr.isError) tc.isError = true
          }
        }
      }
    }
  }

  return uiMessages
}

function replaySessionJsonl(sessionId: string): Message[] {
  const filePath = getSessionTranscriptPath(sessionId)
  if (!filePath || !fs.existsSync(filePath)) return []

  const raw = fs.readFileSync(filePath, 'utf-8').trim()
  if (!raw) return []
  return replayTranscriptMessages(
    raw.split('\n').map(line => parseSessionJsonLine(line)),
  ).messages
}

/** Full session transcript for the web UI (reads `.sessions/{id}.jsonl`). */
export function sessionJsonlToUIMessages(sessionId: string): unknown[] {
  return sessionToUIMessages(replaySessionJsonl(sessionId))
}
