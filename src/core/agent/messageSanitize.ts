import type {
  AssistantContentPart,
  Message,
  RoleMessage,
  ToolResultPart,
  UserContentPart,
} from '../types.js'
import { isAttachmentMessage, isRoleMessage } from '../types.js'
import type { IProvider } from '../../services/llm/types.js'
import { toolResultOutputToText } from '../../utils/tool-result-content.js'
import { reviveBuffersInMessages } from '../../session/json-serialize.js'
import { hydrateToolResultImagesFromDisk } from '../../session/persist-project.js'
import { isCompactBoundaryMessage } from '../messages/compact-boundary.js'

/**
 * Move images out of `tool_result` content and into a meta user message that
 * immediately follows the tool message.
 *
 * Needed for chat-completions providers, which `JSON.stringify` a `content`
 * output — the base64 would land in the prompt as text the model can't see.
 * The relocated form is the same channel Read already uses for image files,
 * and the same one extracted PDF pages are delivered on.
 */
function relocateToolResultImages(messages: RoleMessage[]): RoleMessage[] {
  const out: RoleMessage[] = []

  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) {
      out.push(m)
      continue
    }

    const relocated: UserContentPart[] = []
    const content = (m.content as ToolResultPart[]).map(p => {
      if (p.type !== 'tool-result' || p.output?.type !== 'content') return p

      for (const part of p.output.value) {
        if (part.type !== 'image-data') continue
        relocated.push({
          type: 'text',
          text: `<system-reminder>\nImage from ${p.toolName} (${part.mediaType}).\n</system-reminder>`,
        })
        relocated.push({
          type: 'image',
          image: Buffer.from(part.data, 'base64'),
          mediaType: part.mediaType,
        })
      }

      return {
        ...p,
        output: {
          type: 'text' as const,
          value: toolResultOutputToText(p.output),
        },
      }
    })

    out.push({ ...m, content })
    if (relocated.length > 0) {
      out.push({ role: 'user', content: relocated, isMeta: true })
    }
  }

  return out
}

/**
 * Drop UI-only `toolUseResult` from tool-result parts before the AI SDK /
 * provider sees them. Session JSONL and in-memory history keep the field;
 * only `message.content` reaches the API while `toolUseResult` stays on
 * the envelope.
 *
 * Also downgrades multimodal tool results for providers that can't carry
 * them. History keeps the blocks either way, so switching providers changes
 * the request shape without migrating past sessions.
 */
export function projectMessagesForApi(
  messages: Message[],
  provider?: IProvider,
): RoleMessage[] {
  const projected = reviveBuffersInMessages(messages)
    .filter(m => !isCompactBoundaryMessage(m))
    .filter(isRoleMessage)
    .map(m => {
      if (m.role !== 'tool' || !Array.isArray(m.content)) return m
      return {
        ...m,
        content: (m.content as ToolResultPart[]).map(p => {
          const withShot = hydrateToolResultImagesFromDisk(p)
          if (
            withShot.type !== 'tool-result' ||
            withShot.toolUseResult === undefined
          ) {
            return withShot
          }
          const { toolUseResult: _, ...rest } = withShot
          return rest
        }),
      }
    })

  return provider?.supportsToolResultContentBlocks?.()
    ? projected
    : relocateToolResultImages(projected)
}

/**
 * Maximum number of historical `ReasoningPart`s to inline into the next
 * request. Older reasoning is dropped from the prompt entirely (it still
 * lives on disk and renders in the UI on session reload — this only
 * affects what we resend to the LLM).
 *
 * Why bound it: every turn we re-inline the full prior reasoning as plain
 * text. For deep reasoning models running 5-10 tool steps the prompt grows
 * super-linearly and quickly trips proxy body-size / timeout limits
 * (copilot-api, etc.). Keeping just the most recent block preserves the
 * "what was I just thinking before this tool result" context, which is the
 * piece that actually matters for the next decision.
 */
const KEEP_RECENT_REASONINGS = 1

/**
 * Placeholder used when we have to synthesize a tool-result for an
 * assistant tool-call that has no real result on disk (stream cut between
 * tool-call and tool-result, session resumed from a truncated JSONL, etc.).
 */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'

/**
 * Strip OpenAI Responses-API specific fields from assistant content parts
 * before we persist them. The Responses API attaches `providerOptions.openai
 * .{itemId, reasoningEncryptedContent}` to reasoning, text, and tool-call
 * parts; on the next request the AI SDK serializes any part with an
 * `itemId` as `{type: "item_reference", id: ...}` instead of inline content.
 *
 * Stateless proxies (copilot-api, etc.) don't store those items server-side
 * → the request 404s on the second turn. We therefore drop providerOptions
 * from EVERY assistant part (not just reasoning) so the next request always
 * carries full inline content. Lossy vs OpenAI's native encrypted replay,
 * but portable.
 */
export function sanitizeReasoningParts(messages: Message[]): void {
  for (const msg of messages) {
    if (
      !isRoleMessage(msg) ||
      msg.role !== 'assistant' ||
      !Array.isArray(msg.content)
    )
      continue
    for (const part of msg.content) {
      delete (part as { providerOptions?: unknown }).providerOptions
    }
  }
}

/**
 * Replace every `ReasoningPart` in the conversation with a plain `TextPart`
 * wrapped in `<thinking>…</thinking>` markers. Used right before we hand
 * the messages to the SDK so:
 *
 *   - The Responses API request never contains `{type:"reasoning", id,
 *     encrypted_content}` items (which require a stateful upstream).
 *   - chat/completions / copilot-api proxies just see normal assistant text.
 *   - The model still has visibility into prior chains-of-thought (lossy
 *     but better than nothing).
 *
 * Only the last `KEEP_RECENT_REASONINGS` reasoning parts are inlined;
 * older ones are silently dropped to keep prompt growth bounded.
 *
 * Returns shallow copies; the original `messages` array is not mutated.
 */
export function inlineReasoningAsText(messages: Message[]): Message[] {
  // First pass (back-to-front): mark the most recent N reasoning parts to
  // keep. WeakSet keyed by the part reference makes the second pass cheap.
  const keep = new WeakSet<object>()
  let remaining = KEEP_RECENT_REASONINGS
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i]
    if (
      !isRoleMessage(m) ||
      m.role !== 'assistant' ||
      !Array.isArray(m.content)
    )
      continue
    for (let j = m.content.length - 1; j >= 0 && remaining > 0; j--) {
      const part = m.content[j]
      if (part.type !== 'reasoning') continue
      keep.add(part)
      remaining--
    }
  }

  return messages
    .map((m): Message | null => {
      if (isAttachmentMessage(m)) return m
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return m

      const newContent: AssistantContentPart[] = []
      for (const part of m.content) {
        if (part.type === 'reasoning') {
          if (!keep.has(part)) continue
          const text = (part.text ?? '').trim()
          if (text) {
            newContent.push({
              type: 'text',
              text: `<thinking>\n${text}\n</thinking>`,
            })
          }
          continue
        }
        newContent.push(part)
      }

      if (newContent.length === 0) return null
      return { role: 'assistant', content: newContent }
    })
    .filter((m): m is Message => m !== null)
}

/**
 * Relocate every tool-result block to immediately follow the assistant
 * message that issued its tool-call (matched by `toolCallId`), collapsing
 * each assistant's results into ONE tool message right after it — the
 * "merge same-turn assistant + hoist tool_results" step.
 *
 * Why this matters: providers require tool results to IMMEDIATELY follow
 * the assistant carrying the matching tool-calls. Two real shapes break
 * that adjacency:
 *   - Reasoning models / the AI SDK split one turn into
 *     `[assistant(tool-call), assistant(text)]`, and the trailing text sits
 *     between the call and its result.
 *   - Resume-from-JSONL or compaction detaches results from their calls.
 *
 * Pulling each result back to its owner lets the downstream pairing pass
 * see clean adjacency and recover the REAL tool output, instead of
 * degrading to a synthetic `[Tool result missing…]` placeholder (which is
 * what happens when the real result gets stripped as an "orphan").
 *
 * Rules:
 *   - First occurrence of a given `toolCallId` result wins (dedupe).
 *   - Results are emitted in the assistant's tool-call order (some
 *     providers care about alignment).
 *   - Results whose id matches no assistant tool-call anywhere are dropped
 *     (true orphans).
 *   - Non-tool messages (user attachments, follow-ups) keep their relative
 *     order, so a trailing `user` / `assistant(text)` correctly lands AFTER
 *     the relocated tool message.
 *
 * Returns a new array — does not mutate `messages`.
 */
export function regroupToolResults(messages: Message[]): Message[] {
  const resultById = new Map<string, ToolResultPart>()
  for (const m of messages) {
    if (!isRoleMessage(m) || m.role !== 'tool' || !Array.isArray(m.content))
      continue
    for (const p of m.content) {
      if (p.type === 'tool-result') {
        const tr = p as ToolResultPart
        if (!resultById.has(tr.toolCallId)) resultById.set(tr.toolCallId, tr)
      }
    }
  }

  if (resultById.size === 0) return messages

  const out: Message[] = []
  for (const m of messages) {
    if (isAttachmentMessage(m)) {
      out.push(m)
      continue
    }
    // Drop original tool messages; their results are re-emitted next to the
    // assistant that owns them below.
    if (m.role === 'tool') continue

    out.push(m)

    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue

    const collected: ToolResultPart[] = []
    for (const p of m.content) {
      if (p.type !== 'tool-call') continue
      const id = (p as { toolCallId: string }).toolCallId
      const tr = resultById.get(id)
      if (tr) {
        collected.push(tr)
        resultById.delete(id)
      }
    }
    if (collected.length > 0) {
      out.push({ role: 'tool', content: collected })
    }
  }

  return out
}

/**
 * Defensive bidirectional check of tool-call ↔ tool-result pairing across
 * the ENTIRE message history. Runs once per step in O(n).
 *
 * Two directions:
 *   - Forward: assistant `tool-call` with no matching `tool-result` in the
 *     next tool message → inject a synthetic `[Tool result missing…]`
 *     tool-result so OpenAI's Responses API doesn't 400 on unmatched
 *     `tool_call_id`s.
 *   - Reverse: a `tool-result` whose `toolCallId` doesn't appear in the
 *     preceding assistant's tool-calls → strip it. These orphans come from
 *     session-resume bugs and trigger the mirror 400 ("tool_use_id not
 *     found").
 *
 * Replaces both the per-step `ensureToolResultsPresent` AND the
 * pre-request `ensureToolResultPairing` from the old code. Same invariant,
 * one pass, applied to the whole history right before every streamText
 * call.
 *
 * Returns a new array — does not mutate `messages`. Logs once per repair
 * so the underlying bug stays visible.
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  const out: Message[] = []
  let injected = 0
  let stripped = 0

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!

    if (isAttachmentMessage(m)) {
      out.push(m)
      continue
    }

    if (m.role !== 'assistant' || !Array.isArray(m.content)) {
      // Orphan tool-result handling. Any `tool` message reaching this branch
      // was NOT consumed by a preceding assistant-with-tool-calls — the
      // forward branch below `i++`-consumes every legitimately paired tool
      // message. So a tool message here is an orphan whenever its results
      // don't belong to the immediately-preceding assistant's tool-calls.
      // This covers three real shapes that otherwise 400 the provider with
      // "messages with role 'tool' must be a response to a preceding message
      // with 'tool_calls'":
      //   1. tool at index 0 (resumed from a truncated JSONL),
      //   2. tool after a non-assistant message,
      //   3. tool after an assistant that has NO tool-calls — e.g. compaction
      //      dropped the tool-call assistant, or inlineReasoningAsText turned
      //      a reasoning-only block into a plain <thinking> text message that
      //      now sits right before these results.
      // We match by id (rather than just "is prev an assistant?") so a stray
      // text-only assistant in front of an orphan no longer hides it.
      if (isRoleMessage(m) && m.role === 'tool' && Array.isArray(m.content)) {
        const prev = out.at(-1)
        const prevCallIds = new Set<string>()
        if (
          prev &&
          isRoleMessage(prev) &&
          prev.role === 'assistant' &&
          Array.isArray(prev.content)
        ) {
          for (const p of prev.content) {
            if (p.type === 'tool-call') {
              prevCallIds.add((p as { toolCallId: string }).toolCallId)
            }
          }
        }
        const original = m.content.length
        // Keep non-tool-result parts (shouldn't exist by schema) and any
        // tool-result that actually pairs with the preceding assistant.
        const kept = m.content.filter(
          p =>
            p.type !== 'tool-result' ||
            prevCallIds.has((p as ToolResultPart).toolCallId),
        )
        if (kept.length !== original) {
          stripped += original - kept.length
          // Empty content would leave the API with two non-tool messages
          // in a row (or worse, an empty tool block) — neither is valid.
          // Drop the message entirely when nothing's left.
          if (kept.length > 0) out.push({ role: 'tool', content: kept })
          continue
        }
      }
      out.push(m)
      continue
    }

    const toolCalls: { id: string; name: string }[] = []
    for (const p of m.content) {
      if (p.type === 'tool-call') {
        const tc = p as { toolCallId: string; toolName: string }
        toolCalls.push({ id: tc.toolCallId, name: tc.toolName })
      }
    }

    out.push(m)
    if (toolCalls.length === 0) continue

    const next = messages[i + 1]
    const isNextToolMsg =
      next !== undefined &&
      isRoleMessage(next) &&
      next.role === 'tool' &&
      Array.isArray(next.content)
    const existingResultIds = new Set<string>()
    if (isNextToolMsg) {
      for (const p of next!.content as ToolResultPart[]) {
        if (p.type === 'tool-result') existingResultIds.add(p.toolCallId)
      }
    }

    const callIdSet = new Set(toolCalls.map(tc => tc.id))
    const missing = toolCalls.filter(tc => !existingResultIds.has(tc.id))
    const orphans = new Set<string>()
    for (const rid of existingResultIds) {
      if (!callIdSet.has(rid)) orphans.add(rid)
    }

    if (missing.length === 0 && orphans.size === 0) {
      if (isNextToolMsg) {
        out.push(next!)
        i++
      }
      continue
    }

    injected += missing.length
    stripped += orphans.size

    const syntheticParts: ToolResultPart[] = missing.map(tc => ({
      type: 'tool-result',
      toolCallId: tc.id,
      toolName: tc.name,
      output: { type: 'text', value: SYNTHETIC_TOOL_RESULT_PLACEHOLDER },
    }))

    if (isNextToolMsg) {
      const kept = (next!.content as ToolResultPart[]).filter(
        p => !(p.type === 'tool-result' && orphans.has(p.toolCallId)),
      )
      // Synthetic blocks go FIRST so their order matches the assistant's
      // tool-call order — some providers care about that alignment.
      out.push({ role: 'tool', content: [...syntheticParts, ...kept] })
      i++
    } else if (syntheticParts.length > 0) {
      out.push({ role: 'tool', content: syntheticParts })
    }
  }

  if (injected > 0 || stripped > 0) {
    console.warn(
      `[agent] ensureToolResultPairing repaired conversation: ` +
        `+${injected} synthetic tool-results, -${stripped} orphan tool-results`,
    )
  }

  return out
}
