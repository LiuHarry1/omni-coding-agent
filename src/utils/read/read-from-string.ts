/**
 * Slice an in-memory text buffer into Read Out (raw lines, dual-channel).
 * Shared by local disk reads and remote/SSH `readText` paths.
 */
import * as path from 'path'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForFileType,
} from '../../services/tokenEstimation.js'
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_LINES_TO_READ } from './limits.js'
import type { ReadTextOutput } from './types.js'
import {
  MaxFileReadLinesExceededError,
  MaxFileReadTokenExceededError,
} from './types.js'

export function roughTokenEstimate(text: string): number {
  return roughTokenCountEstimation(text)
}

function boundaryOrRawText(
  displayPath: string,
  selectedLines: string[],
  startLine: number,
  totalLines: number,
): ReadTextOutput {
  if (totalLines === 0) {
    return {
      type: 'text',
      file: {
        filePath: displayPath,
        content: '',
        numLines: 0,
        startLine: 1,
        totalLines: 0,
      },
    }
  }
  if (selectedLines.length === 0) {
    return {
      type: 'text',
      file: {
        filePath: displayPath,
        content: '',
        numLines: 0,
        startLine,
        totalLines,
      },
    }
  }

  return {
    type: 'text',
    file: {
      filePath: displayPath,
      content: selectedLines.join('\n'),
      numLines: selectedLines.length,
      startLine,
      totalLines,
    },
  }
}

function assertOutputTokenBudget(content: string, displayPath: string): void {
  if (!content) return
  const ext = path.extname(displayPath).toLowerCase().slice(1)
  const tokens = roughTokenCountEstimationForFileType(content, ext)
  if (tokens > DEFAULT_MAX_OUTPUT_TOKENS) {
    throw new MaxFileReadTokenExceededError(tokens, DEFAULT_MAX_OUTPUT_TOKENS)
  }
}

export type ReadTextFromStringOptions = {
  offset?: number
  limit?: number
  /**
   * When false, skip whole-file line-count gate (caller already ranged, or
   * truncated attachment path). Default true.
   */
  enforceWholeFileLineGate?: boolean
}

/**
 * Parse UTF-8 text into dual-channel Read Out.
 * Applies line/token gates; does not check on-disk byte size.
 */
export function readTextFromString(
  text: string,
  displayPath: string,
  options?: ReadTextFromStringOptions,
): ReadTextOutput {
  if (text.length === 0) {
    return boundaryOrRawText(displayPath, [], 1, 0)
  }

  const hasRange =
    options?.limit != null || (options?.offset != null && options.offset > 1)
  const enforceLineGate = options?.enforceWholeFileLineGate !== false

  let lines = text.split('\n')
  const totalLines = lines.length

  if (enforceLineGate && !hasRange && totalLines > MAX_LINES_TO_READ) {
    throw new MaxFileReadLinesExceededError(totalLines, MAX_LINES_TO_READ)
  }

  let startLine = 1
  const { offset, limit } = options ?? {}
  if (offset != null && offset < 0) {
    startLine = Math.max(1, totalLines + offset + 1)
    lines = lines.slice(startLine - 1)
  } else if (offset != null && offset > 0) {
    startLine = offset
    lines = lines.slice(offset - 1)
  }

  const effectiveLimit =
    limit != null && limit > 0
      ? Math.min(limit, MAX_LINES_TO_READ)
      : hasRange
        ? MAX_LINES_TO_READ
        : undefined
  if (effectiveLimit != null) lines = lines.slice(0, effectiveLimit)

  const out = boundaryOrRawText(displayPath, lines, startLine, totalLines)
  assertOutputTokenBudget(out.file.content, displayPath)
  return out
}
