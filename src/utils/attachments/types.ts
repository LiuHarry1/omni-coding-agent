import type { ReadOutput } from '../read/types.js'

export type FileAttachment = {
  type: 'file'
  filename: string
  displayPath: string
  content: ReadOutput
  truncated?: boolean
  /**
   * Extra guidance appended after the synthetic Read result — e.g. the CSV
   * shape summary and on-disk path for a composer attachment the model may
   * want to process with a shell instead of reading inline.
   */
  note?: string
}

/**
 * A composer attachment we deliberately keep out of the context window
 * (Office docs, archives, binaries). The model gets a path and is expected to
 * reach for Bash.
 */
export type UploadedBinaryAttachment = {
  type: 'uploaded_binary'
  /** Agent-host path. */
  filename: string
  displayPath: string
  mediaType: string
  fileSize: number
  /** Copy inside the SSH/cloud environment where shell commands run. */
  shellPath?: string
  /** Why the copy into a remote environment failed. */
  shellCopyError?: string
}

export type PdfReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  displayPath: string
  pageCount: number
  fileSize: number
}

export type DirectoryAttachment = {
  type: 'directory'
  path: string
  displayPath: string
  content: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  displayPath: string
  content: ReadOutput
}

export type DiagnosticSeverity = 'Error' | 'Warning' | 'Info' | 'Hint'

export interface Diagnostic {
  message: string
  severity: DiagnosticSeverity
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

export type DiagnosticsAttachment = {
  type: 'diagnostics'
  files: DiagnosticFile[]
  isNew?: boolean
}

export type PlanModeAttachment = {
  type: 'plan_mode'
  reminderType: 'full' | 'sparse'
  planFilePath: string
  planExists: boolean
}

export type PlanModeReentryAttachment = {
  type: 'plan_mode_reentry'
  planFilePath: string
}

export type PlanModeExitAttachment = {
  type: 'plan_mode_exit'
  planFilePath: string
  planExists: boolean
}

export type SkillListingAttachment = {
  type: 'skill_listing'
  content: string
}

export type InvokedSkillsAttachment = {
  type: 'invoked_skills'
  skills: Array<{
    name: string
    path: string
    content: string
  }>
}

export type AgentListingDeltaAttachment = {
  type: 'agent_listing_delta'
  addedTypes: string[]
  addedLines: string[]
  removedTypes: string[]
  isInitial: boolean
}

/** User @-mentioned a subagent. */
export type AgentMentionAttachment = {
  type: 'agent_mention'
  agentType: string
}

export type TaskNotificationAttachment = {
  type: 'task_notification'
  taskId: string
  outputFile: string
  status: 'completed' | 'failed' | 'killed' | 'unknown'
  summary: string
  toolUseId?: string
  rawXml: string
}

/** Prefetched auto-memory topic files. */
export type RelevantMemoriesAttachment = {
  type: 'relevant_memories'
  memories: Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
}

export type ConditionalRulesAttachment = {
  type: 'conditional_rules'
  rules: Array<{
    path: string
    label: string
    content: string
    patterns: string[]
  }>
}

/** A file the model has read was changed on disk by something else. */
export type EditedTextFileAttachment = {
  type: 'edited_text_file'
  filename: string
  /** Changed regions of the new content, with line numbers. */
  snippet: string
}

/** The todo tool has gone unused for a while. */
export type TodoReminderAttachment = {
  type: 'todo_reminder'
  content: Array<{ content: string; status: string }>
  itemCount: number
}

/** A hook refused something (exit code 2 or `decision: block`). */
export type HookBlockingErrorAttachment = {
  type: 'hook_blocking_error'
  /** `PostToolUse:Edit`, `Stop`, ... */
  hookName: string
  blockingError: { blockingError: string; command: string }
}

/** Text a hook asked to be shown to the model. */
export type HookAdditionalContextAttachment = {
  type: 'hook_additional_context'
  hookName: string
  content: string[]
}

/** Plain output of a hook that succeeded (UserPromptSubmit context). */
export type HookSuccessAttachment = {
  type: 'hook_success'
  hookName: string
  content: string
}

/** A hook answered `continue: false`. */
export type HookStoppedContinuationAttachment = {
  type: 'hook_stopped_continuation'
  hookName: string
  message: string
}

/**
 * A label for a batch of tool calls, kept in the transcript so the UI can
 * show it again after a reload. The model never sees it.
 */
export type ToolUseSummaryAttachment = {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
}

export type Attachment =
  | ToolUseSummaryAttachment
  | EditedTextFileAttachment
  | TodoReminderAttachment
  | HookBlockingErrorAttachment
  | HookAdditionalContextAttachment
  | HookSuccessAttachment
  | HookStoppedContinuationAttachment
  | FileAttachment
  | UploadedBinaryAttachment
  | PdfReferenceAttachment
  | DirectoryAttachment
  | AlreadyReadFileAttachment
  | DiagnosticsAttachment
  | PlanModeAttachment
  | PlanModeReentryAttachment
  | PlanModeExitAttachment
  | SkillListingAttachment
  | InvokedSkillsAttachment
  | AgentListingDeltaAttachment
  | AgentMentionAttachment
  | TaskNotificationAttachment
  | RelevantMemoriesAttachment
  | ConditionalRulesAttachment
