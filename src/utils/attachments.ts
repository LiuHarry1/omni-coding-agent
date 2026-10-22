/**
 * Attachment API — unified getAttachments / getAttachmentMessages.
 */
import { randomUUID } from 'crypto'
import {
  isAttachmentMessage,
  type AttachmentMessage,
  type Message,
  type ToolUseContext,
} from '../core/types.js'
import type { Attachment } from './attachments/types.js'
import { processAtMentionedFiles } from './attachments/generate-file-attachment.js'
import {
  getPlanModeAttachments,
  getPlanModeExitAttachment,
} from './attachments/plan-mode.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../services/lsp/LSPDiagnosticRegistry.js'
import { getLspWorkspaceKey, hasLspServers } from '../services/lsp/manager.js'
import { getAvailableShellToolNames } from '../core/shell/shell-utils.js'
import { getAgentListingDeltaAttachments } from '../tools/AgentTool/agentListing.js'
import { drainTaskNotifications } from '../utils/task/pendingNotifications.js'
import { loadConditionalRulesForPaths } from './rules-loader.js'
import { extractAgentMentions } from './attachments/extract-mentions.js'
import type { AgentDefinition } from '../core/types.js'

function getAgentMentionAttachments(
  input: string,
  agents: readonly AgentDefinition[] | undefined,
): Attachment[] {
  if (!agents?.length) return []
  const mentions = extractAgentMentions(input)
  if (mentions.length === 0) return []
  const out: Attachment[] = []
  for (const agentType of mentions) {
    const def = agents.find(a => a.agentType === agentType)
    if (!def || def.mode === 'primary') continue
    out.push({ type: 'agent_mention', agentType: def.agentType })
  }
  return out
}

function getSkillListingAttachments(ctx: ToolUseContext): Attachment[] {
  const content = ctx.skillListingContent?.trim()
  if (!content) return []
  if (ctx.session.skillListingAnnounced) return []
  ctx.session.skillListingAnnounced = true
  return [{ type: 'skill_listing', content }]
}

function getTaskNotificationAttachments(ctx: ToolUseContext): Attachment[] {
  const sessionId = ctx.session?.id
  if (!sessionId) return []
  return drainTaskNotifications(sessionId).map(n => ({
    type: 'task_notification' as const,
    taskId: n.taskId,
    outputFile: n.outputFile,
    status: n.status,
    summary: n.summary,
    toolUseId: n.toolUseId,
    rawXml: n.rawXml,
  }))
}

function getConditionalRulesAttachments(
  ctx: ToolUseContext,
  messages: readonly Message[] = [],
): Attachment[] {
  if (!ctx.conditionalRulesEnabled || ctx.readFileState.size === 0) return []

  const surfaced = new Set<string>()
  for (const message of messages) {
    if (
      isAttachmentMessage(message) &&
      message.attachment.type === 'conditional_rules'
    ) {
      for (const rule of message.attachment.rules) surfaced.add(rule.path)
    }
  }

  const rules = loadConditionalRulesForPaths(ctx.cwd, [
    ...ctx.readFileState.keys(),
  ]).filter(rule => !surfaced.has(rule.path))
  return rules.length > 0 ? [{ type: 'conditional_rules', rules }] : []
}

async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  try {
    return await f()
  } catch (err) {
    console.warn(
      `[attachments] ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

async function getLSPDiagnosticAttachments(
  ctx: ToolUseContext,
): Promise<Attachment[]> {
  const shellTools = getAvailableShellToolNames()
  if (!Object.keys(ctx.options.tools).some(name => shellTools.includes(name))) {
    return []
  }
  if (!hasLspServers(ctx.lspServers)) return []

  const workspaceKey = getLspWorkspaceKey(ctx.cwd, ctx.lspServers)
  const diagnosticSets = checkForLSPDiagnostics(workspaceKey)
  if (diagnosticSets.length === 0) return []

  const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
    type: 'diagnostics',
    files,
    isNew: true,
  }))

  clearAllLSPDiagnostics(workspaceKey)
  console.log(
    `[lsp:diagnostics] attach workspace=${workspaceKey} attachments=${attachments.length}`,
  )
  return attachments
}

export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  messages?: Message[],
): Promise<Attachment[]> {
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () =>
          processAtMentionedFiles(input, {
            cwd: toolUseContext.cwd,
            readFileState: toolUseContext.readFileState,
          }),
        ),
        maybe('agent_mentions', () =>
          Promise.resolve(
            getAgentMentionAttachments(
              input,
              toolUseContext.agentDefinitions?.activeAgents,
            ),
          ),
        ),
      ]
    : []

  const allThreadAttachments = [
    ...(input
      ? [
          maybe('skill_listing', () =>
            Promise.resolve(getSkillListingAttachments(toolUseContext)),
          ),
          maybe('agent_listing_delta', () =>
            Promise.resolve(
              getAgentListingDeltaAttachments(toolUseContext, messages),
            ),
          ),
        ]
      : []),
    maybe('plan_mode', () =>
      Promise.resolve(getPlanModeAttachments(messages, toolUseContext)),
    ),
    maybe('plan_mode_exit', () =>
      Promise.resolve(getPlanModeExitAttachment(toolUseContext)),
    ),
  ]

  const mainThreadAttachments = [
    maybe('conditional_rules', () =>
      Promise.resolve(getConditionalRulesAttachments(toolUseContext, messages)),
    ),
    maybe('lsp_diagnostics', () => getLSPDiagnosticAttachments(toolUseContext)),
    maybe('task_notifications', () =>
      Promise.resolve(getTaskNotificationAttachments(toolUseContext)),
    ),
  ]

  const [userResults, threadResults, mainResults] = await Promise.all([
    Promise.all(userInputAttachments),
    Promise.all(allThreadAttachments),
    Promise.all(mainThreadAttachments),
  ])

  return [
    ...userResults.flat(),
    ...threadResults.flat(),
    ...mainResults.flat(),
  ].filter((a): a is Attachment => a != null)
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    type: 'attachment',
    attachment,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isMeta: true,
  }
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  messages?: Message[],
): AsyncGenerator<AttachmentMessage, void> {
  const attachments = await getAttachments(input, toolUseContext, messages)
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

export type { Attachment } from './attachments/types.js'
