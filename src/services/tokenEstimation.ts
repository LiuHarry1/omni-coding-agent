/**
 * Rough token estimation used wherever no real API usage is available.
 */
import { BROWSER_TOOL_NAMES } from '../constants/tool_names.js'

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.ceil(content.length / bytesPerToken)
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

const DENSE_TOOL_RESULT_NAMES = new Set<string>(BROWSER_TOOL_NAMES)

/**
 * Browser results are accessibility-tree YAML, CDP JSON and ref ids — as
 * dense as JSON, so the default 4 undercounts them about 2x.
 */
export function bytesPerTokenForToolResult(toolName: string): number {
  return DENSE_TOOL_RESULT_NAMES.has(toolName) ? 2 : 4
}
