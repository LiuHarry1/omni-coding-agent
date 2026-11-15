/**
 * LLM summarization engine for full compaction.
 * Summarizes the complete active projection, then emits append-only
 * boundary + summary + attachment events. Full compact keeps no verbatim tail.
 */
import { generateText } from 'ai'
import type {
  IProvider,
  Message,
  RoleMessage,
  RunAgentFn,
  TodoItem,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import {
  runForkedAgent,
  type CacheSafeParams,
} from '../../core/forked-agent.js'
import {
  estimateConversationTokens,
  tokenCountWithEstimation,
} from './tokens.js'
import {
  buildPostCompactAttachmentMessages,
  type CompactEnrichment,
} from './post-compact-attachments.js'
import { extractRecentlyReadFiles, restoreRecentFiles } from './fileRestore.js'
import { ensureMessageUuid } from '../session-memory/messageUuid.js'
import { formatCompactSummaryMessage } from '../session-memory/prompts.js'
import { createCompactBoundaryMessage } from '../../core/messages/compact-boundary.js'
import {
  calculateMessagesToKeepIndex,
  sliceMessagesToKeep,
  type KeepIndexConfig,
} from '../session-memory/keepIndex.js'
import {
  ensureToolResultPairing,
  inlineReasoningAsText,
  projectMessagesForApi,
  regroupToolResults,
} from '../../core/agent/messageSanitize.js'
import {
  expandAttachmentMessagesForAPI,
  mergeAdjacentUserMessages,
  smooshSystemReminderSiblings,
} from '../../utils/messages.js'

export type { CompactEnrichment } from './post-compact-attachments.js'

// ── Prompt (analysis + summary) ─────────────────────────

// aggressive no-tools preamble FIRST. On adaptive-thinking models
// the summarizer sometimes attempts a tool call despite a weak instruction;
// being explicit about rejection consequences up front prevents a wasted turn.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn -- you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// weaker reminder repeated at the very end as a trailer.
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only -- ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

const BASE_COMPACT_PROMPT = `You are compacting an AI coding agent's conversation to save context space.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`

/**
 * Assemble the summarizer system prompt:
 *   preamble + base + (optional "Additional Instructions") + trailer.
 *
 * `customInstructions` come from a manual `/compact <instructions>` invocation
 * (or a future PreCompact hook); when present they steer what the summary
 * focuses on (e.g. "focus on the test failures and the API changes").
 */
export function buildSummarySystem(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions.trim()}`
  }
  prompt += NO_TOOLS_TRAILER
  return prompt
}

// ── File restoration config ─────────────────────────────

export interface FileRestoreConfig {
  maxFiles: number
  maxTokensPerFile: number
  totalBudget: number
}

// ── Public API ──────────────────────────────────────────

export interface CompactResult {
  /** Active model view after appending `appendMessages` to the transcript. */
  messages: Message[]
  /** Events appended to the complete transcript; never includes a verbatim tail. */
  appendMessages: Message[]
  /** Raw summary text (without restored files/todos) -- for UI display. */
  summary: string
  summaryLength: number
  estimatedTokensAfter: number
  source: 'full'
  messagesToKeep: Message[]
}

export interface CompactContext {
  cwd: string
  todos: TodoItem[]
  fileRestore: FileRestoreConfig
  /** Optional steering text from a manual `/compact <instructions>` call. */
  instructions?: string
  /** Request-scoped provider; falls back to default provider when absent. */
  provider?: IProvider
  /** Re-inject agent listings + invoked_skills after full compact. */
  enrichment?: CompactEnrichment
  /**
   * Skip re-injecting recently-read file contents (aggressive/reactive
   * compaction -- the context just overflowed; don't re-inflate it).
   */
  skipFileRestore?: boolean
  trigger?: 'manual' | 'auto'
  preTokens?: number
  /** Main-loop runner used by the cache-safe summarizer fork. */
  runAgent?: RunAgentFn
  /** Main-loop cache prefix and cache-critical request parameters. */
  cacheSafeParams?: CacheSafeParams
  /**
   * Reactive-only fallback: summarize the head and reference a recent
   * verbatim tail from the append-only transcript.
   */
  preserveRecentTail?: KeepIndexConfig
}

// MAX_PTL_RETRIES = 3. If the summarizer call itself overflows,
// drop the oldest API round and retry, up to this many times.
const MAX_SUMMARIZE_RETRIES = 3

/**
 * Drop the oldest "API round" from the message list for prompt-too-long recovery.
 *
 * Primary strategy: group by the assistant round `id` (the
 * provider's response id). The first round is everything up to and including
 * the messages sharing the first assistant id; we drop it and keep the rest.
 * This stays correct for long single-user-turn agentic sessions (where
 * user-boundary grouping would collapse to one round) AND never splits
 * parallel tool calls, since they share the same round id.
 *
 * Fallbacks when ids are unavailable (older sessions / non-streaming):
 *   - split on the next user-message boundary, else
 *   - drop the oldest ~30% of messages.
 */
function dropOldestApiRound(messages: Message[]): Message[] {
  // 1) id-based: find the first assistant id, then the first index whose round
  //    differs from it. Everything before that index is the oldest round.
  const firstId = firstAssistantRoundId(messages)
  if (firstId !== undefined) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (
        isRoleMessage(m) &&
        m.role === 'assistant' &&
        m.id !== undefined &&
        m.id !== firstId
      ) {
        // Keep the real user prompt that initiated this next API round. An
        // assistant-first retry can be rejected or semantically detached.
        for (let userIndex = i - 1; userIndex >= 0; userIndex--) {
          const candidate = messages[userIndex]!
          if (isRoleMessage(candidate) && candidate.role === 'user') {
            return [candidate, ...messages.slice(i)]
          }
        }
        break
      }
    }
    // Only one round carries an id -- fall through to coarser strategies.
  }

  // 2) user-boundary: drop up to the second user message.
  let firstUser = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (isRoleMessage(m) && m.role === 'user') {
      firstUser = i
      break
    }
  }
  for (let i = firstUser + 1; i < messages.length; i++) {
    const m = messages[i]
    if (isRoleMessage(m) && m.role === 'user') {
      return messages.slice(i)
    }
  }

  // 3) blunt fallback: drop oldest ~30%.
  const at = Math.max(1, Math.floor(messages.length * 0.3))
  return messages.slice(at)
}

/** First assistant message's round id, or undefined if none carry one. */
function firstAssistantRoundId(messages: Message[]): string | undefined {
  for (const m of messages) {
    if (isRoleMessage(m) && m.role === 'assistant' && m.id !== undefined)
      return m.id
  }
  return undefined
}

/**
 * Summarize the active projection (or only its head for reactive fallback),
 * then build append-only compact events. Ordinary full compact has no tail.
 *
 * `keepStartIndex` is accepted temporarily for source compatibility but is
 * intentionally ignored.
 * Returns null if summarization fails.
 */
export async function compactConversation(
  messages: Message[],
  model: string,
  ctx: CompactContext,
  _keepStartIndex?: number,
): Promise<CompactResult | null> {
  if (messages.length < 2) return null

  let messagesToKeep: Message[] = []
  let messagesToSummarize = messages
  if (ctx.preserveRecentTail) {
    const keepStart = calculateMessagesToKeepIndex(
      messages,
      undefined,
      ctx.preserveRecentTail,
    )
    // Reactive fallback must never silently degrade to ordinary full wipe.
    // If there is no useful head/tail split, leave the transcript untouched.
    if (keepStart <= 0 || keepStart >= messages.length) return null
    messagesToKeep = sliceMessagesToKeep(messages, keepStart)
    messagesToSummarize = messages.slice(0, keepStart)
  }
  if (messagesToSummarize.length < 2) return null

  let pending = messagesToSummarize.slice()

  let summary: string | undefined

  for (let attempt = 0; attempt <= MAX_SUMMARIZE_RETRIES; attempt++) {
    try {
      if (!ctx.provider) {
        throw new Error(
          'compactConversation requires a request-scoped provider',
        )
      }
      const provider = ctx.provider
      const prompt = buildSummarySystem(ctx.instructions)
      let rawSummary: string

      if (ctx.runAgent && ctx.cacheSafeParams) {
        try {
          const result = await runForkedAgent({
            prompt,
            runAgent: ctx.runAgent,
            cacheSafeParams: {
              ...ctx.cacheSafeParams,
              forkContextMessages: pending.slice(),
            },
            canUseTool: () => ({
              behavior: 'deny',
              message: 'Tools are disabled during conversation compaction.',
            }),
            forkLabel: 'full_compact',
            maxSteps: 1,
            cwd: ctx.cwd,
          })
          rawSummary = result.text
        } catch (forkError) {
          const message =
            forkError instanceof Error ? forkError.message : String(forkError)
          console.warn(
            `[compact] cache-safe fork failed; using generateText fallback: ${message}`,
          )
          rawSummary = await generateSummaryFallback(
            pending,
            model,
            provider,
            prompt,
          )
        }
      } else {
        rawSummary = await generateSummaryFallback(
          pending,
          model,
          provider,
          prompt,
        )
      }

      summary = formatCompactSummary(rawSummary)
      break
    } catch (error) {
      if (attempt < MAX_SUMMARIZE_RETRIES && isLikelyTooLong(error)) {
        const before = pending.length
        pending = dropOldestApiRound(pending)
        if (pending.length === before || pending.length < 1) {
          throw error
        }
        console.warn(
          `[compact] PTL recovery: dropped oldest API round (${before} -> ${pending.length} msgs), retrying`,
        )
        continue
      }
      throw error
    }
  }

  if (!summary) return null

  const recentFiles = ctx.skipFileRestore
    ? []
    : extractRecentlyReadFiles(messages)
  const fileSection = restoreRecentFiles(
    recentFiles,
    ctx.cwd,
    ctx.fileRestore,
    messagesToKeep,
  )
  const summaryMessages = buildPostCompactMessages(
    summary,
    fileSection,
    ctx.todos,
    messagesToKeep.length > 0,
  )
  const attachmentMessages = ctx.enrichment
    ? await buildPostCompactAttachmentMessages(ctx.cwd, ctx.enrichment)
    : []
  const lastMessage = messages[messages.length - 1]
  const lastUuid =
    lastMessage && 'uuid' in lastMessage ? lastMessage.uuid : undefined
  const boundary = createCompactBoundaryMessage(
    ctx.trigger ?? 'auto',
    ctx.preTokens ?? estimateConversationTokens(messages),
    lastUuid,
    ctx.instructions,
    messagesToSummarize.length,
  )
  const summaryAnchor = summaryMessages[0]?.uuid
  const firstKeptUuid = messagesToKeep[0]?.uuid
  const lastKeptUuid = messagesToKeep.at(-1)?.uuid
  if (
    summaryAnchor &&
    firstKeptUuid &&
    lastKeptUuid &&
    messagesToKeep.length > 0
  ) {
    boundary.compactMetadata.preservedSegment = {
      headUuid: firstKeptUuid,
      anchorUuid: summaryAnchor,
      tailUuid: lastKeptUuid,
    }
  }
  const appendMessages: Message[] = [
    boundary,
    ...summaryMessages,
    ...attachmentMessages,
  ]

  return {
    messages: [
      boundary,
      ...summaryMessages,
      ...messagesToKeep,
      ...attachmentMessages,
    ],
    appendMessages,
    summary,
    summaryLength: summary.length,
    estimatedTokensAfter: tokenCountWithEstimation([
      boundary,
      ...summaryMessages,
      ...messagesToKeep,
      ...attachmentMessages,
    ]).total,
    source: 'full',
    messagesToKeep,
  }
}

/** Output budget of a fallback summary request. */
const COMPACT_MAX_OUTPUT_TOKENS = 20_000

function mediaPlaceholder(mediaType?: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text:
      !mediaType || mediaType.startsWith('image/') ? '[image]' : '[document]',
  }
}

/**
 * Replaces images and documents with placeholders. The summary does not need
 * them, and screenshots are what most often push this request over the limit.
 */
export function stripMediaForSummary(messages: RoleMessage[]): RoleMessage[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message
    if (message.role === 'user') {
      return {
        ...message,
        content: message.content.map(part =>
          part.type === 'image'
            ? mediaPlaceholder()
            : part.type === 'file'
              ? mediaPlaceholder(part.mediaType)
              : part,
        ),
      }
    }
    if (message.role === 'tool') {
      return {
        ...message,
        content: message.content.map(part => {
          if (part.type !== 'tool-result' || part.output.type !== 'content') {
            return part
          }
          return {
            ...part,
            output: {
              ...part.output,
              value: part.output.value.map(item =>
                item.type === 'text'
                  ? item
                  : mediaPlaceholder(
                      'mediaType' in item
                        ? item.mediaType
                        : (item as { type: string }).type.startsWith('image')
                          ? 'image/*'
                          : 'application/octet-stream',
                    ),
              ),
            },
          }
        }),
      }
    }
    return message
  }) as RoleMessage[]
}

async function generateSummaryFallback(
  messages: Message[],
  model: string,
  provider: IProvider,
  system: string,
): Promise<string> {
  const conversation = stripMediaForSummary(
    prepareSummaryMessages(messages, provider),
  )
  const result = await generateText({
    model: provider.chatModel(model),
    system,
    maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
    messages: [
      ...conversation,
      {
        role: 'user',
        content:
          'Compact the complete agent conversation above into the requested structured summary.',
      },
    ],
  })
  return result.text
}

function prepareSummaryMessages(
  messages: Message[],
  provider: IProvider,
): RoleMessage[] {
  return projectMessagesForApi(
    ensureToolResultPairing(
      smooshSystemReminderSiblings(
        mergeAdjacentUserMessages(
          regroupToolResults(
            expandAttachmentMessagesForAPI(inlineReasoningAsText(messages)),
          ),
        ),
      ),
    ),
    provider,
  )
}

// ── Post-compact message construction ───────────────────

function buildPostCompactMessages(
  summary: string,
  fileSection: string,
  todos: TodoItem[],
  recentMessagesPreserved: boolean,
): Message[] {
  let body = summary
  if (fileSection) {
    body += `\n\n${fileSection}`
  }
  if (todos.length > 0) {
    const todoLines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
    body += `\n\n## Active Todo List\nUpdate via todo_write(merge=true) as you complete items:\n${todoLines.join('\n')}`
  }
  const content = formatCompactSummaryMessage(body, {
    recentMessagesPreserved,
  })
  return [
    ensureMessageUuid({
      role: 'user',
      content,
      isCompactSummary: true,
    }),
  ]
}

// ── Format compact summary (strip analysis scratchpad) ──

function formatCompactSummary(raw: string): string {
  let result = raw
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    result = summaryMatch[1]!.trim()
  }
  result = result.replace(/\n\n\n+/g, '\n\n')
  return result.trim()
}

function isLikelyTooLong(err: unknown): boolean {
  if (!err) return false
  const e = err as { statusCode?: number; status?: number; message?: string }
  const status = e.statusCode ?? e.status
  if (status === 413) return true
  const msg = (e.message ?? '').toLowerCase()
  return (
    msg.includes('context length') ||
    msg.includes('too long') ||
    msg.includes('token')
  )
}
