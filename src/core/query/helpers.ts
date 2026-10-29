import { ensureMessageUuid } from '../../services/session-memory/index.js'
import type {
  AgentOptions,
  AnyTool,
  Message,
  TodoItem,
  TodoStatus,
  UserContentPart,
  UserFileAttachment,
  UserMessage,
} from '../types.js'
import { isRoleMessage } from '../types.js'
import type { WireEmitter } from '../wire-emitter.js'
import { emitTodoUpdate } from '../wire-internal.js'
import {
  TOOL_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
} from '../../constants/tool_names.js'
import type { StreamResult } from '../agent/streamConsumer.js'
import {
  mediaTypeForExt,
  parseChatUploadUrl,
  parseDataUrl,
} from '../../utils/chat-uploads.js'
import {
  parseMaxTokensContextOverflowError,
  type MaxTokensContextOverflow,
} from '../stream-errors.js'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  applyMaxTokensToChatBody,
  getMaxOutputTokens,
} from '../llm/max-tokens.js'

export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  applyMaxTokensToChatBody,
  getMaxOutputTokens,
}

export const MAX_TRANSIENT_RETRIES = 2
/** Max retry attempts for overflow max_tokens adjustment */
export const MAX_OVERFLOW_RETRIES = 2
/** Lowest max_tokens an output budget is ever shrunk to */
export const FLOOR_OUTPUT_TOKENS = 3_000
/** Headroom kept between the input tokens and the output budget */
export const OUTPUT_SAFETY_BUFFER = 1_000

/** Default / resolve console tag: `[agent:main]` or `[agent:session_memory]`. */
export function agentLogTag(logLabel?: string): string {
  return `agent:${logLabel ?? 'main'}`
}

/**
 * Shrink max_tokens so input + output fits the window.
 * Returns undefined when remaining budget is below FLOOR (we do not raise
 * max_tokens up to the floor) or when the input count is only a lower bound.
 */
export function adjustMaxTokensForContextOverflow(
  overflow: MaxTokensContextOverflow,
): number | undefined {
  if (overflow.inputIsLowerBound) return undefined
  const availableContext = Math.max(
    0,
    overflow.contextLimit - overflow.inputTokens - OUTPUT_SAFETY_BUFFER,
  )
  if (availableContext < FLOOR_OUTPUT_TOKENS) return undefined
  return Math.max(FLOOR_OUTPUT_TOKENS, availableContext)
}

export function maxTokensOverrideFromError(err: unknown): number | undefined {
  const overflow = parseMaxTokensContextOverflowError(err)
  if (!overflow) return undefined
  return adjustMaxTokensForContextOverflow(overflow)
}

/**
 * Build a user message. Image refs should already be durable upload URLs
 * (`/sessions/{id}/uploads/{file}`) from `offloadChatImageRefs`. Legacy data
 * URLs are accepted as a last resort (prefer offload so session JSONL never
 * embeds megabyte base64).
 *
 * Parts store short string refs — bytes are hydrated in `projectMessagesForApi`.
 */
export function buildUserMessage(
  text: string,
  images?: string[],
  isMeta?: boolean,
  files?: UserFileAttachment[],
  displayContent?: string,
): UserMessage {
  const meta = {
    ...(isMeta ? { isMeta: true as const } : {}),
    ...(files?.length ? { files } : {}),
    ...(displayContent && displayContent !== text ? { displayContent } : {}),
  }
  if (!images || images.length === 0) {
    return ensureMessageUuid({ role: 'user', content: text, ...meta })
  }
  const parts: UserContentPart[] = [{ type: 'text', text }]
  for (const ref of images) {
    const upload = parseChatUploadUrl(ref)
    if (upload) {
      const ext = upload.fileName.split('.').pop() || 'png'
      parts.push({
        type: 'image',
        image: ref,
        mediaType: mediaTypeForExt(ext),
      })
      continue
    }
    if (ref.startsWith('data:')) {
      const { mediaType } = parseDataUrl(ref)
      parts.push({ type: 'image', image: ref, mediaType })
      continue
    }
    throw new Error(
      `Unsupported image ref in buildUserMessage: ${ref.slice(0, 120)}`,
    )
  }
  return ensureMessageUuid({ role: 'user', content: parts, ...meta })
}

export function autoCompleteTodos(
  todos: TodoItem[],
  eventBus: AgentOptions['eventBus'],
  wire: WireEmitter,
): void {
  const hasIncomplete = todos.some(
    t => t.status === 'pending' || t.status === 'in_progress',
  )
  if (!hasIncomplete) return
  const updated = todos.map(t =>
    t.status === 'pending' || t.status === 'in_progress'
      ? { ...t, status: 'completed' as TodoStatus }
      : t,
  )
  emitTodoUpdate(wire, eventBus, updated)
}

function formatTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
  return `[Active todo list -- update via ${TODO_WRITE_TOOL_NAME}(merge=true) as you complete items]\n${lines.join('\n')}`
}

export function attachTodoReminderAfterCompaction(
  messages: Message[],
  todos: TodoItem[],
): void {
  if (todos.length === 0) return
  const last = messages[messages.length - 1]
  if (
    !last ||
    !isRoleMessage(last) ||
    last.role !== 'assistant' ||
    !Array.isArray(last.content)
  )
    return
  const existing = last.content.find(p => p.type === 'text')
  const reminder = '\n\n' + formatTodoReminder(todos)
  if (existing && 'text' in existing) {
    existing.text += reminder
  } else {
    last.content.push({ type: 'text', text: reminder })
  }
}

export function activateDeferredTools(
  toolCalls: StreamResult['toolCalls'],
  pool: Record<string, AnyTool>,
  active: Record<string, AnyTool>,
  discovered: Set<string>,
): void {
  for (const tc of toolCalls) {
    if (tc.toolName !== TOOL_SEARCH_TOOL_NAME) continue
    const query = (tc.input as { query?: string }).query
    if (!query) continue

    const trimmed = query.trim()
    let names: string[] = []

    const prefixed = trimmed.toLowerCase().startsWith('select:')
    const rest = prefixed ? trimmed.slice(7) : trimmed
    const commaParts = rest
      .split(',')
      .map(n => n.trim())
      .filter(Boolean)
    if (
      prefixed ||
      (commaParts.length > 1 && commaParts.some(n => n in pool))
    ) {
      names = commaParts
    } else {
      const kw = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
      for (const name of Object.keys(pool)) {
        if (kw.some(k => name.toLowerCase().includes(k))) {
          names.push(name)
        }
      }
    }

    for (const name of names) {
      if (pool[name] && !active[name]) {
        active[name] = pool[name]
        delete pool[name]
        discovered.add(name)
        console.log(`[agent] activated deferred tool: ${name}`)
      }
    }
  }
}

export function syncToolSet(
  target: Record<string, AnyTool>,
  source: Record<string, AnyTool>,
): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key]
  }
  Object.assign(target, source)
}
