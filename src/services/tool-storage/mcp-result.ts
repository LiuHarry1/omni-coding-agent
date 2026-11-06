/**
 * Large MCP tool results.
 *
 * Local sessions mirror Claude Code: `transformMCPResult` picks one payload
 * (structuredContent over the content array), `processMCPResult` persists
 * results above MAX_MCP_OUTPUT_TOKENS with `getLargeOutputInstructions`, and
 * `maybePersistLargeToolResult` persists anything above the MCP tool's 50K
 * char cap with a plain preview.
 *
 * Host-only sessions (cloud, SSH) cannot run jq or other shell tools on the
 * spill file, so the file is rendered line-oriented (nested JSON expanded,
 * embedded newlines restored) for Read and Grep.
 */
import {
  PREVIEW_SIZE_CHARS,
  buildLargeResultPreview,
  formatFileSize,
  generatePreview,
  getPersistThresholdChars,
  isToolResultsHostOnly,
  writeToolResultFile,
  PERSISTED_OUTPUT_CLOSE,
  PERSISTED_OUTPUT_OPEN,
} from './index.js'

type McpBlock = { type: string; [key: string]: unknown }

export interface McpCallResult {
  content?: McpBlock[]
  structuredContent?: unknown
  toolResult?: unknown
  isError?: boolean
}

type TextBlock = { type: 'text'; text: string }

type McpResultType = 'toolResult' | 'structuredContent' | 'contentArray'

interface TransformedMcpResult {
  content: string | TextBlock[]
  type: McpResultType
  schema?: string
}

export interface ProcessedMcpResult {
  result: string
  isError: boolean
}

const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000
/** Claude Code: min(MCPTool.maxResultSizeChars 100K, DEFAULT_MAX_RESULT_SIZE_CHARS 50K). */
const MCP_PERSIST_THRESHOLD_CHARS = 50_000

export function isMcpCallResult(raw: unknown): raw is McpCallResult {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  if ('toolResult' in r) return true
  return (
    Array.isArray(r.content) &&
    r.content.every(
      b =>
        !!b &&
        typeof b === 'object' &&
        typeof (b as McpBlock).type === 'string',
    )
  )
}

export function getMaxMcpOutputTokens(): number {
  const parsed = parseInt(process.env.MAX_MCP_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_MCP_OUTPUT_TOKENS
}

/** Compact, jq-friendly type signature, e.g. `{items: [{id: number}]}`. */
export function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value).slice(0, 10)
    const props = entries.map(
      ([k, v]) => `${k}: ${inferCompactSchema(v, depth - 1)}`,
    )
    const suffix = Object.keys(value).length > 10 ? ', ...' : ''
    return `{${props.join(', ')}${suffix}}`
  }
  return typeof value
}

function toTextBlocks(block: McpBlock, toolName: string): TextBlock[] | null {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: String(block.text ?? '') }]
    case 'resource': {
      const resource = (block.resource ?? {}) as Record<string, unknown>
      if (typeof resource.text !== 'string') return null
      return [
        {
          type: 'text',
          text: `[Resource from ${toolName} at ${String(resource.uri)}] ${resource.text}`,
        },
      ]
    }
    case 'resource_link': {
      let text = `[Resource link: ${String(block.name)}] ${String(block.uri)}`
      if (block.description) text += ` (${String(block.description)})`
      return [{ type: 'text', text }]
    }
    default:
      return null
  }
}

/** Null when the result holds binary blocks (images, audio, blobs). */
function transformMcpResult(
  raw: McpCallResult,
  toolName: string,
): TransformedMcpResult | null {
  if ('toolResult' in raw) {
    return { content: String(raw.toolResult), type: 'toolResult' }
  }
  if (raw.structuredContent !== undefined) {
    return {
      content: JSON.stringify(raw.structuredContent),
      type: 'structuredContent',
      schema: inferCompactSchema(raw.structuredContent),
    }
  }
  const blocks: TextBlock[] = []
  for (const block of raw.content ?? []) {
    const converted = toTextBlocks(block, toolName)
    if (!converted) return null
    blocks.push(...converted)
  }
  return {
    content: blocks,
    type: 'contentArray',
    schema: inferCompactSchema(blocks),
  }
}

function modelText(content: string | TextBlock[]): string {
  return typeof content === 'string'
    ? content
    : content.map(b => b.text).join('\n')
}

function contentChars(content: string | TextBlock[]): number {
  return typeof content === 'string'
    ? content.length
    : content.reduce((n, b) => n + b.text.length, 0)
}

function estimateTokens(content: string | TextBlock[]): number {
  return typeof content === 'string'
    ? Math.round(content.length / 4)
    : content.reduce((n, b) => n + Math.round(b.text.length / 4), 0)
}

function getFormatDescription(type: McpResultType, schema?: string): string {
  switch (type) {
    case 'toolResult':
      return 'Plain text'
    case 'structuredContent':
      return schema ? `JSON with schema: ${schema}` : 'JSON'
    case 'contentArray':
      return schema ? `JSON array with schema: ${schema}` : 'JSON array'
  }
}

/** Claude Code `getLargeOutputInstructions` (no Bash read limit). */
export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
): string {
  return (
    `Error: result (${contentLength.toLocaleString()} characters) exceeds maximum allowed tokens. Output has been saved to ${rawOutputPath}.\n` +
    `Format: ${formatDescription}\n` +
    `Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\n` +
    `REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n` +
    `- You MUST read the content from the file at ${rawOutputPath} in sequential chunks until 100% of the content has been read.\n` +
    `- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n` +
    `- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n`
  )
}

function processLocal(
  transformed: TransformedMcpResult,
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
): string {
  const { content, type, schema } = transformed
  const contentStr =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2)

  if (estimateTokens(content) > getMaxMcpOutputTokens()) {
    const filePath = writeToolResultFile(
      sessionId,
      toolCallId,
      toolName,
      contentStr,
    )
    if (!filePath) {
      return `Error: result (${contentStr.length.toLocaleString()} characters) exceeds maximum allowed tokens. Failed to save output to file. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data.`
    }
    return getLargeOutputInstructions(
      filePath,
      contentStr.length,
      getFormatDescription(type, schema),
    )
  }

  if (contentChars(content) > MCP_PERSIST_THRESHOLD_CHARS) {
    const filePath = writeToolResultFile(
      sessionId,
      toolCallId,
      toolName,
      contentStr,
    )
    if (filePath) {
      const preview = generatePreview(contentStr, PREVIEW_SIZE_CHARS)
      return (
        `${PERSISTED_OUTPUT_OPEN} path="${filePath}" tool="${toolName}" chars="${contentStr.length}">\n` +
        `Output too large (${formatFileSize(contentStr.length)}). Full output saved to: ${filePath}\n\n` +
        `Preview (first ${formatFileSize(PREVIEW_SIZE_CHARS)}):\n` +
        preview +
        (preview.length < contentStr.length ? '\n...\n' : '\n') +
        PERSISTED_OUTPUT_CLOSE
      )
    }
  }

  return modelText(content)
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

function isLeaf(value: unknown): boolean {
  if (typeof value === 'string') {
    return !value.includes('\n') && parseJson(value) === undefined
  }
  if (value === null || typeof value !== 'object') return true
  return Array.isArray(value)
    ? value.length === 0
    : Object.keys(value).length === 0
}

/** Indented `key: value` lines; multi-line strings keep their own lines. */
function renderLines(value: unknown, indent: string, out: string[]): void {
  if (typeof value === 'string') {
    const nested = parseJson(value)
    if (nested !== undefined) {
      renderLines(nested, indent, out)
      return
    }
    for (const line of value.split('\n')) out.push(indent + line)
    return
  }
  if (value === null || typeof value !== 'object') {
    out.push(indent + scalar(value))
    return
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [`[${i}]`, v])
    : Object.entries(value)
  if (entries.length === 0) {
    out.push(indent + (Array.isArray(value) ? '[]' : '{}'))
    return
  }
  for (const [key, child] of entries) {
    if (isLeaf(child)) {
      out.push(`${indent}${key}: ${scalar(child)}`)
    } else {
      out.push(`${indent}${key}:`)
      renderLines(child, indent + '  ', out)
    }
  }
}

export function renderForLineTools(transformed: TransformedMcpResult): string {
  const out: string[] = []
  if (typeof transformed.content === 'string') {
    renderLines(transformed.content, '', out)
  } else {
    transformed.content.forEach((block, i) => {
      if (i > 0) out.push('')
      renderLines(block.text, '', out)
    })
  }
  return out.join('\n') + '\n'
}

function processHostOnly(
  transformed: TransformedMcpResult,
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
): string {
  const text = modelText(transformed.content)
  if (text.length <= getPersistThresholdChars(toolName)) return text
  const rendered = renderForLineTools(transformed)
  const filePath = writeToolResultFile(
    sessionId,
    toolCallId,
    toolName,
    rendered,
  )
  if (!filePath) return text
  return buildLargeResultPreview(filePath, toolName, rendered, true)
}

/**
 * Model-facing text for an MCP call result, persisting it when large.
 * Null when the result carries binary blocks the caller must handle.
 */
export function processMcpToolResult(
  raw: McpCallResult,
  opts: { sessionId: string | undefined; toolCallId: string; toolName: string },
): ProcessedMcpResult | null {
  const transformed = transformMcpResult(raw, opts.toolName)
  if (!transformed) return null
  const process = isToolResultsHostOnly(opts.sessionId)
    ? processHostOnly
    : processLocal
  return {
    result: process(
      transformed,
      opts.sessionId,
      opts.toolCallId,
      opts.toolName,
    ),
    isError: raw.isError === true,
  }
}
