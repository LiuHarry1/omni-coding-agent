/**
 * Public API for the compaction module.
 * External code imports from here — internal files are implementation details.
 */
export {
  attachTokenUsage,
  readTokenUsage,
  clearTokenUsages,
  tokenCountWithEstimation,
  estimateMessageTokens,
  estimateConversationTokens,
} from './tokens.js'
export type { AttachedTokenUsage } from './tokens.js'
export { toAttachedUsage } from './tokens.js'

export {
  applyMicroCompactProjection,
  getActiveModelMessages,
  microCompact,
  rebaseMicroCompactState,
  resetMicroCompactState,
} from './microCompact.js'
export type { MicroCompactResult } from './microCompact.js'

export { compactConversation } from './compact.js'
export type {
  CompactResult,
  CompactContext,
  FileRestoreConfig,
  CompactEnrichment,
} from './compact.js'

export {
  buildPostCompactAttachmentMessages,
  countPostCompactAgentListing,
  createSkillAttachmentIfNeeded,
  POST_COMPACT_MAX_TOKENS_PER_SKILL,
  POST_COMPACT_SKILLS_TOKEN_BUDGET,
} from './post-compact-attachments.js'

export {
  compactIfNeeded,
  compactionLimits,
  resetCompactionFailures,
  isSummarizingCompactSource,
} from './autoCompact.js'
export type {
  CompactOptions,
  CompactOutcome,
  CompactSource,
} from './autoCompact.js'
