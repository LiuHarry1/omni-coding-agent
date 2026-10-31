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
  filename: string
  displayPath: string
  mediaType: string
  fileSize: number
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

export type Attachment =
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
