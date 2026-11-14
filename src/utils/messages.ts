/**
 * Message normalization — expand AttachmentMessage for API requests.
 */
import type {
  Diagnostic,
  DiagnosticFile,
  Message,
  TextPart,
  ToolMessage,
  ToolResultPart,
  UserContentPart,
  UserMessage,
} from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import type { Attachment } from './attachments/types.js'
import { attachmentToMessages } from './attachments/attachment-to-messages.js'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
} from '../constants/tool_names.js'
import { wrapInSystemReminder } from './system-reminder.js'

const MAX_DIAGNOSTICS_SUMMARY_CHARS = 8000
const SR_PREFIX = '<system-reminder>'

export function wrapMessagesInSystemReminder(
  messages: UserMessage[],
): UserMessage[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return {
        ...msg,
        content: wrapInSystemReminder(msg.content),
      }
    }
    const wrappedContent = msg.content.map(block => {
      if (block.type === 'text') {
        return {
          ...block,
          text: wrapInSystemReminder(block.text),
        }
      }
      return block
    })
    return { ...msg, content: wrappedContent }
  })
}

function metaUserMessage(content: string): UserMessage {
  return { role: 'user', content, isMeta: true }
}

function severitySymbol(severity: Diagnostic['severity']): string {
  switch (severity) {
    case 'Error':
      return '✗'
    case 'Warning':
      return '⚠'
    case 'Info':
      return 'ℹ'
    case 'Hint':
      return '★'
    default:
      return '•'
  }
}

function formatDiagnosticsSummary(files: DiagnosticFile[]): string {
  const truncationMarker = '…[truncated]'
  const result = files
    .map(file => {
      const filename = file.uri.split('/').pop() || file.uri
      const diagnostics = file.diagnostics
        .map(d => {
          return `  ${severitySymbol(d.severity)} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
        })
        .join('\n')
      return `${filename}:\n${diagnostics}`
    })
    .join('\n\n')

  if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
    return (
      result.slice(0, MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length) +
      truncationMarker
    )
  }
  return result
}

function sparsePlanReminder(planFilePath: string): string {
  return `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${planFilePath}). Follow 5-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`
}

function fullPlanReminder(planFilePath: string, exists: boolean): string {
  return `Plan mode is active. You MUST NOT make any edits except the plan file, run shell commands on the main thread, or spawn non-Explore/Plan subagents.

Plan file: ${planFilePath}${exists ? ' (exists — read it first)' : ' (not created yet)'}

Workflow: Phase 1 Explore agents → Phase 2 Plan agents → Phase 3 Review/Ask → Phase 4 Write plan file → Phase 5 ${EXIT_PLAN_MODE_TOOL_NAME}

End each turn with ${ASK_USER_QUESTION_TOOL_NAME} or ${EXIT_PLAN_MODE_TOOL_NAME} — not plain text alone.`
}

function getPlanModeInstructions(
  attachment: Extract<Attachment, { type: 'plan_mode' }>,
): UserMessage[] {
  const content =
    attachment.reminderType === 'full'
      ? fullPlanReminder(attachment.planFilePath, attachment.planExists)
      : sparsePlanReminder(attachment.planFilePath)
  return wrapMessagesInSystemReminder([metaUserMessage(content)])
}

function normalizeAttachmentForAPI(attachment: Attachment): UserMessage[] {
  switch (attachment.type) {
    case 'directory':
    case 'file':
    case 'already_read_file':
    case 'uploaded_binary':
    case 'pdf_reference':
      return wrapMessagesInSystemReminder(
        attachmentToMessages(attachment) as UserMessage[],
      )

    case 'diagnostics': {
      if (attachment.files.length === 0) return []
      const diagnosticSummary = formatDiagnosticsSummary(attachment.files)
      return wrapMessagesInSystemReminder([
        metaUserMessage(
          `<new-diagnostics>The following new diagnostic issues were detected:\n\n${diagnosticSummary}</new-diagnostics>`,
        ),
      ])
    }

    case 'plan_mode':
      return getPlanModeInstructions(attachment)

    case 'plan_mode_reentry':
      return wrapMessagesInSystemReminder([
        metaUserMessage(`## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${attachment.planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${EXIT_PLAN_MODE_TOOL_NAME}

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`),
      ])

    case 'plan_mode_exit': {
      const planReference = attachment.planExists
        ? ` The plan file is located at ${attachment.planFilePath} if you need to reference it.`
        : ''
      return wrapMessagesInSystemReminder([
        metaUserMessage(`## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`),
      ])
    }

    case 'skill_listing': {
      if (!attachment.content) return []
      return wrapMessagesInSystemReminder([
        metaUserMessage(
          `The following skills are available for use with the Skill tool:\n\n${attachment.content}`,
        ),
      ])
    }

    case 'invoked_skills': {
      if (attachment.skills.length === 0) return []
      const skillsContent = attachment.skills
        .map(
          skill =>
            `### Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`,
        )
        .join('\n\n---\n\n')
      return wrapMessagesInSystemReminder([
        metaUserMessage(
          `The following skills were invoked in this session. Continue to follow these guidelines:\n\n${skillsContent}`,
        ),
      ])
    }

    case 'agent_listing_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        const header = attachment.isInitial
          ? 'Available agent types for the Agent tool:'
          : 'New agent types are now available for the Agent tool:'
        parts.push(`${header}\n${attachment.addedLines.join('\n')}`)
      }
      if (attachment.removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map(t => `- ${t}`).join('\n')}`,
        )
      }
      if (parts.length === 0) return []
      return wrapMessagesInSystemReminder([metaUserMessage(parts.join('\n\n'))])
    }

    case 'agent_mention': {
      return wrapMessagesInSystemReminder([
        metaUserMessage(
          `The user has expressed a desire to invoke the agent "${attachment.agentType}". Please invoke the agent appropriately, passing in the required context to it.`,
        ),
      ])
    }

    case 'task_notification': {
      return wrapMessagesInSystemReminder([metaUserMessage(attachment.rawXml)])
    }

    case 'conditional_rules': {
      return wrapMessagesInSystemReminder(
        attachment.rules.map(rule =>
          metaUserMessage(
            `Conditional instructions from ${rule.path} ` +
              `(matched paths: ${rule.patterns.join(', ')}):\n\n${rule.content}`,
          ),
        ),
      )
    }

    case 'relevant_memories': {
      return wrapMessagesInSystemReminder(
        attachment.memories.map(m =>
          metaUserMessage(`${m.header}\n\n${m.content}`),
        ),
      )
    }

    case 'edited_text_file':
      return wrapMessagesInSystemReminder([
        metaUserMessage(
          `Note: ${attachment.filename} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. Here are the relevant changes (shown with line numbers):\n${attachment.snippet}`,
        ),
      ])

    case 'todo_reminder': {
      const todoItems = attachment.content
        .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
        .join('\n')

      let message = `The ${TODO_WRITE_TOOL_NAME} tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the ${TODO_WRITE_TOOL_NAME} tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`
      if (todoItems.length > 0) {
        message += `\n\nHere are the existing contents of your todo list:\n\n[${todoItems}]`
      }
      return wrapMessagesInSystemReminder([metaUserMessage(message)])
    }
  }
}

export function expandAttachmentMessagesForAPI(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const msg of messages) {
    if (isAttachmentMessage(msg)) {
      out.push(...normalizeAttachmentForAPI(msg.attachment))
    } else {
      out.push(msg)
    }
  }
  return out
}

function normalizeUserContent(
  content: string | UserContentPart[],
): UserContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content
}

function denormalizeUserContent(
  parts: UserContentPart[],
): string | UserContentPart[] {
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text
  }
  return parts
}

function isSystemReminderText(part: UserContentPart): part is TextPart {
  return part.type === 'text' && part.text.startsWith(SR_PREFIX)
}

function isSimulatedToolResultAnchor(part: UserContentPart): part is TextPart {
  return (
    part.type === 'text' &&
    part.text.includes('Result of calling the') &&
    part.text.startsWith(SR_PREFIX)
  )
}

function isSystemReminderOnlyUser(msg: UserMessage): boolean {
  const parts = normalizeUserContent(msg.content)
  return parts.length > 0 && parts.every(isSystemReminderText)
}

function smooshIntoSimulatedToolResult(
  anchor: TextPart,
  blocks: UserContentPart[],
): TextPart {
  const joined = [
    anchor.text.trim(),
    ...blocks.filter(isSystemReminderText).map(b => b.text.trim()),
  ]
    .filter(Boolean)
    .join('\n\n')
  return { type: 'text', text: joined }
}

/**
 * Concatenate two content arrays, appending `\n` to a's last text block when
 * the seam is text-text. Mirrors the joinTextAtSeam.
 */
function joinTextAtSeam(
  a: UserContentPart[],
  b: UserContentPart[],
): UserContentPart[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: lastA.text + '\n' }, ...b]
  }
  return [...a, ...b]
}

/**
 * When merging into a simulated tool-result anchor, fold SR siblings into the
 * result block (mergeUserContentBlocks / smooshIntoToolResult for SDK text).
 */
function mergeUserContentBlocks(
  a: UserContentPart[],
  b: UserContentPart[],
): UserContentPart[] {
  const lastBlock = a.at(-1)
  if (lastBlock && isSimulatedToolResultAnchor(lastBlock)) {
    const toSmoosh = b.filter(isSystemReminderText)
    const rest = b.filter(p => !isSystemReminderText(p))
    if (toSmoosh.length > 0) {
      return [
        ...a.slice(0, -1),
        smooshIntoSimulatedToolResult(lastBlock, toSmoosh),
        ...rest,
      ]
    }
  }
  return joinTextAtSeam(a, b)
}

/** Merge user messages, smooshing SR siblings into simulated tool results. */
function mergeUserMessagesAndToolResults(
  a: UserMessage,
  b: UserMessage,
): UserMessage {
  const merged = mergeUserContentBlocks(
    normalizeUserContent(a.content),
    normalizeUserContent(b.content),
  )
  return {
    role: 'user',
    content: denormalizeUserContent(merged),
    isMeta: a.isMeta && b.isMeta ? true : undefined,
  }
}

/**
 * Collapse consecutive `role: user` messages before the SDK/provider sees
 * them. History and JSONL keep fine-grained attachment structure.
 */
export function mergeAdjacentUserMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const prev = out.at(-1)
    if (
      isRoleMessage(m) &&
      m.role === 'user' &&
      prev !== undefined &&
      isRoleMessage(prev) &&
      prev.role === 'user'
    ) {
      out[out.length - 1] = mergeUserMessagesAndToolResults(prev, m)
    } else {
      out.push(m)
    }
  }
  return out
}

function smooshUserMessageContent(msg: UserMessage): UserMessage {
  const content = normalizeUserContent(msg.content)
  let anchorIdx = -1
  for (let k = content.length - 1; k >= 0; k--) {
    if (isSimulatedToolResultAnchor(content[k]!)) {
      anchorIdx = k
      break
    }
  }
  if (anchorIdx === -1) return msg

  const anchorPart = content[anchorIdx]!
  if (!isSimulatedToolResultAnchor(anchorPart)) return msg

  const toSmoosh = content.filter(
    (p, k) => k !== anchorIdx && isSystemReminderText(p),
  )
  if (toSmoosh.length === 0) return msg

  const smooshed = smooshIntoSimulatedToolResult(anchorPart, toSmoosh)
  const kept = content.filter(
    (p, k) => k !== anchorIdx && !isSystemReminderText(p),
  )
  kept.splice(Math.min(anchorIdx, kept.length), 0, smooshed)
  return { ...msg, content: denormalizeUserContent(kept) }
}

function appendTextToToolResult(
  part: ToolResultPart,
  extraText: string,
): ToolResultPart {
  const extra = extraText.trim()
  if (!extra) return part
  // Multimodal results keep their blocks; the reminder becomes a trailing
  // text block so the image still reaches the model.
  if (part.output.type === 'content') {
    return {
      ...part,
      output: {
        type: 'content',
        value: [...part.output.value, { type: 'text', text: extra }],
      },
    }
  }
  const value = [part.output.value.trim(), extra].filter(Boolean).join('\n\n')
  return {
    ...part,
    output: { type: 'text', value },
  }
}

function smooshSrIntoToolMessage(
  toolMsg: ToolMessage,
  srUsers: UserMessage[],
): ToolMessage {
  const extraText = srUsers
    .flatMap(u => normalizeUserContent(u.content))
    .filter(isSystemReminderText)
    .map(p => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!extraText) return toolMsg

  const content = toolMsg.content.map((part, i, arr) =>
    i === arr.length - 1 && part.type === 'tool-result'
      ? appendTextToToolResult(part, extraText)
      : part,
  )
  return { role: 'tool', content }
}

/**
 * Fold `<system-reminder>` siblings into simulated tool-result anchors within
 * user messages, and into real tool-result outputs when SR meta users follow
 * a tool message (smooshSystemReminderSiblings, SDK-adapted).
 */
export function smooshSystemReminderSiblings(messages: Message[]): Message[] {
  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i]!

    if (
      isRoleMessage(raw) &&
      raw.role === 'tool' &&
      Array.isArray(raw.content)
    ) {
      const srSiblings: UserMessage[] = []
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]!
        if (!isRoleMessage(next) || next.role !== 'user' || !next.isMeta) break
        if (!isSystemReminderOnlyUser(next)) break
        srSiblings.push(next)
        j++
      }
      if (srSiblings.length > 0) {
        out.push(smooshSrIntoToolMessage(raw, srSiblings))
        i = j - 1
        continue
      }
    }

    if (isRoleMessage(raw) && raw.role === 'user') {
      out.push(smooshUserMessageContent(raw))
      continue
    }

    out.push(raw)
  }
  return out
}
