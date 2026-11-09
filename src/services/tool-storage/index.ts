/**
 * Persist large tool outputs to disk so prompts stay small.
 *
 * Execute time: results over the threshold are written to a sidecar file and
 * REPLACED in the conversation by a short preview + file path -- the model
 * re-reads the file when it actually needs more than the preview. This caps
 * context growth at the source (a single 117KB Read ~ 30k tokens used to
 * enter the context verbatim and re-trigger compaction every turn).
 *
 * Applies to ALL tools by size, not a tool-name whitelist -- MCP tools
 * (doc retrievers etc.) routinely return the largest payloads and were
 * previously exempt from every context-shedding mechanism.
 *
 * The replacement is deterministic per toolCallId (persisted once, preview
 * derived from the same bytes), so repeated turns produce byte-identical
 * prompts and the provider prompt cache stays warm (freeze decisions per
 * tool_use_id for the same reason).
 *
 * Micro-compact time: older already-full payloads (from sessions predating
 * this cap) are offloaded to the same sidecar + reference format.
 */
import * as fs from 'fs'
import * as path from 'path'
import { getToolResultFilePath } from '../../core/session-paths.js'
import { BROWSER_MODEL_RESULT_MAX_CHARS } from '../../browser/limits.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'

export const PERSISTED_OUTPUT_OPEN = '<persisted-output'
export const PERSISTED_OUTPUT_CLOSE = '</persisted-output>'

/** Preview kept inline when a result is offloaded. */
export const PREVIEW_SIZE_CHARS = 2_000
const DEFAULT_PERSIST_THRESHOLD_CHARS = 32_768

/**
 * Sessions whose shell cannot see the agent host's session files (SSH, or a
 * cloud container that mounts another user's `.ai-agent`). Spill files live
 * on the agent host, so their instructions must steer the model to Read/Grep.
 * Subagents share the parent's sessionId.
 */
const hostOnlySessions = new Set<string>()

export function setToolResultsHostOnly(
  sessionId: string,
  hostOnly: boolean,
): void {
  if (hostOnly) hostOnlySessions.add(sessionId)
  else hostOnlySessions.delete(sessionId)
}

export function isToolResultsHostOnly(sessionId: string | undefined): boolean {
  return !!sessionId && hostOnlySessions.has(sessionId)
}

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Result size (chars) above which output is offloaded to a sidecar file. */
export function getPersistThresholdChars(toolName?: string): number {
  // Read self-bounds via its token limit; persisting its output to a file the
  // model reads back with Read is circular.
  if (toolName === FILE_READ_TOOL_NAME) return Infinity
  const env = parseEnvInt('TOOL_PERSIST_THRESHOLD_CHARS', 0)
  if (env > 0) return env
  if (typeof toolName === 'string' && toolName.startsWith('browser_')) {
    return BROWSER_MODEL_RESULT_MAX_CHARS
  }
  return DEFAULT_PERSIST_THRESHOLD_CHARS
}

export function isPersistedReference(text: string): boolean {
  return text.includes(PERSISTED_OUTPUT_OPEN)
}

/** Rewrite a persisted reference after its session data directory moves. */
export function relocatePersistedReference(
  text: string,
  filePath: string,
): string {
  if (!isPersistedReference(text)) return text
  const oldPath = /<persisted-output\s+path="([^"]*)"/.exec(text)?.[1]
  if (!oldPath) return text
  return text.replaceAll(oldPath, filePath)
}

function formatBytes(chars: number): string {
  if (chars >= 1024 * 1024) return `${(chars / (1024 * 1024)).toFixed(1)} MB`
  if (chars >= 1024) return `${(chars / 1024).toFixed(1)} KB`
  return `${chars} chars`
}

/** Claude Code `formatFileSize`, used verbatim in local-session messages. */
export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024
  if (kb < 1) return `${sizeInBytes} bytes`
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')}GB`
}

/**
 * Truncate at a newline boundary when one exists reasonably close to the
 * limit so the preview doesn't cut mid-line.
 */
export function generatePreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const truncated = content.slice(0, maxChars)
  const lastNewline = truncated.lastIndexOf('\n')
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars
  return content.slice(0, cutPoint)
}

/**
 * Write full output to `.sessions/{id}/tool-results/{toolCallId}.txt`.
 * Returns absolute path, or null on failure / below threshold / no session.
 */
export function persistToolResult(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  content: string,
): string | null {
  if (!sessionId) return null
  const threshold = getPersistThresholdChars(toolName)
  if (content.length <= threshold) return null
  return writeToolResultFile(sessionId, toolCallId, toolName, content)
}

/** Write `content` to the tool-results sidecar regardless of size. */
export function writeToolResultFile(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  content: string,
): string | null {
  if (!sessionId) return null
  try {
    const filePath = getToolResultFilePath(sessionId, toolCallId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // toolCallId is unique per invocation -- skip rewrite if already persisted.
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8')
    }
    console.log(
      `[tool-storage] PERSIST ${toolName} ${toolCallId.slice(0, 12)}... -- ` +
        `${formatBytes(content.length)} -> ${filePath} (inline content replaced by preview)`,
    )
    return filePath
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[tool-storage] persist failed for ${toolCallId}: ${msg}`)
    return null
  }
}

const HOST_ONLY_NOTICE =
  'This file is on the agent host, outside the workspace. Open it only with the Read or Grep tool; shell commands cannot reach it.'

/**
 * Inline replacement for an oversized result: header + preview + path.
 * Local sessions get Claude Code's `buildLargeToolResultMessage` body;
 * host-only sessions also get Read/Grep-only instructions.
 */
export function buildLargeResultPreview(
  filePath: string,
  toolName: string,
  content: string,
  hostOnly = false,
): string {
  const preview = generatePreview(content, PREVIEW_SIZE_CHARS)
  const hasMore = preview.length < content.length
  const open = `${PERSISTED_OUTPUT_OPEN} path="${filePath}" tool="${toolName}" chars="${content.length}">\n`
  const tail = preview + (hasMore ? '\n...\n' : '\n') + PERSISTED_OUTPUT_CLOSE
  if (!hostOnly) {
    return (
      open +
      `Output too large (${formatFileSize(content.length)}). Full output saved to: ${filePath}\n\n` +
      `Preview (first ${formatFileSize(PREVIEW_SIZE_CHARS)}):\n` +
      tail
    )
  }
  return (
    open +
    `Output too large (${formatBytes(content.length)}). Full output saved to: ${filePath}\n` +
    `${HOST_ONLY_NOTICE}\n` +
    `To answer from it, use Grep on this path to locate the relevant sections, then Read them with offset and limit.\n` +
    `Before summarizing or analyzing it, state which portion of the file you read. If you did not read all of it, say so explicitly.\n\n` +
    `Preview (first ${formatBytes(preview.length)}):\n` +
    tail
  )
}

/** Short reference replacing an old payload cleared during micro-compact. */
export function buildPersistedReference(
  filePath: string,
  toolName: string,
  originalChars: number,
  hostOnly = false,
): string {
  return (
    `${PERSISTED_OUTPUT_OPEN} path="${filePath}" tool="${toolName}" chars="${originalChars}">\n` +
    `[Previous ${toolName} output (${formatBytes(originalChars)}) offloaded to disk to save context.` +
    (hostOnly
      ? ` ${HOST_ONLY_NOTICE}]\n`
      : ` Full output saved to: ${filePath}]\n`) +
    `${PERSISTED_OUTPUT_CLOSE}`
  )
}

/**
 * After tool execute: results over the threshold are persisted and replaced
 * inline by a preview + file path. Below-threshold results pass through
 * unchanged. Already-offloaded references are never re-wrapped.
 */
export function maybePersistAfterExecute(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  result: string,
): string {
  if (isPersistedReference(result)) return result
  const filePath = persistToolResult(sessionId, toolCallId, toolName, result)
  if (!filePath) return result
  return buildLargeResultPreview(
    filePath,
    toolName,
    result,
    isToolResultsHostOnly(sessionId),
  )
}

/**
 * Micro-compact helper: ensure sidecar exists, return reference text.
 * Falls back to the generic cleared marker when session/path unavailable.
 * Works for any tool (payloads from sessions predating the execute-time cap,
 * or below-threshold-but-clearable old results).
 */
export function offloadReferenceForCompact(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  content: string,
  fallbackMarker: string,
): string {
  if (isPersistedReference(content)) return content

  if (sessionId && content.length > 0) {
    const filePath = getToolResultFilePath(sessionId, toolCallId)
    if (!fs.existsSync(filePath)) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, content, 'utf-8')
        console.log(
          `[tool-storage] PERSIST (on compact) ${toolName} ${toolCallId.slice(0, 12)}... -> ${filePath}`,
        )
      } catch {
        return fallbackMarker
      }
    }
    return buildPersistedReference(
      filePath,
      toolName,
      content.length,
      isToolResultsHostOnly(sessionId),
    )
  }

  return fallbackMarker
}
