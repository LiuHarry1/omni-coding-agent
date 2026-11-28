/**
 * MCP tool results.
 *
 * Content blocks are converted as in Claude Code's `transformResultContent`:
 * text and resources become text, images become image blocks that fit the
 * API limits, and other binary content is saved to a file whose path is
 * returned.
 *
 * The text is then sized. Local sessions mirror Claude Code:
 * `transformMCPResult` picks one payload (structuredContent over the content
 * array), `processMCPResult` persists results above MAX_MCP_OUTPUT_TOKENS
 * with `getLargeOutputInstructions`, and `maybePersistLargeToolResult`
 * persists anything above the MCP tool's 50K char cap with a plain preview.
 *
 * Host-only sessions (cloud, SSH) cannot run jq or other shell tools on the
 * spill file, so the file is rendered line-oriented (nested JSON expanded,
 * embedded newlines restored) for Read and Grep.
 *
 * A result with images that is still above MAX_MCP_OUTPUT_TOKENS, each image
 * counted as IMAGE_TOKEN_ESTIMATE, is cut down as in Claude Code's
 * `truncateMcpContent`: images past the budget are compressed into what is
 * left of it, or dropped.
 *
 * Three differences from Claude Code, where it loses content:
 * - Images are kept when the result also has structuredContent. Claude Code
 *   drops the whole content array, so a screenshot tool that also reports
 *   its dimensions reaches the model without the screenshot.
 * - An error keeps all of its text, and its structuredContent after it.
 *   Claude Code keeps the first text block only.
 * - The text of a result with images is persisted like any other text.
 *   Claude Code truncates it, because it would persist the images with it.
 */
import {
  PREVIEW_SIZE_CHARS,
  buildLargeResultPreview,
  formatFileSize,
  generatePreview,
  getPersistThresholdChars,
  isToolResultsHostOnly,
  saveBinaryToolResult,
  writeToolResultFile,
  PERSISTED_OUTPUT_CLOSE,
  PERSISTED_OUTPUT_OPEN,
} from './index.js'
import type {
  ImageMediaType,
  ToolResultContentBlockParam,
} from '../../core/types.js'
import {
  compressImageBufferToBytes,
  toolResultImageBlockFromBuffer,
} from '../../utils/image/resize-buffer.js'
import {
  buildImageBlock,
  hasImageBlock,
  toolResultBlocksToText,
} from '../../utils/tool-result-content.js'

type McpBlock = { type: string; [key: string]: unknown }

export interface McpCallResult {
  content?: McpBlock[]
  structuredContent?: unknown
  toolResult?: unknown
  isError?: boolean
}

interface McpCallContext {
  sessionId: string | undefined
  toolCallId: string
  toolName: string
}

type TextBlock = { type: 'text'; text: string }

type McpResultType = 'toolResult' | 'structuredContent' | 'contentArray'

interface TransformedMcpResult {
  content: string | TextBlock[]
  type: McpResultType
  schema?: string
}

export interface ProcessedMcpResult {
  /** Text projection; an image appears as `[image]`. */
  result: string
  /** Model-facing blocks, set only when the result carries images. */
  blocks?: ToolResultContentBlockParam[]
  isError: boolean
}

const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000
/** Claude Code `IMAGE_TOKEN_ESTIMATE`. */
const IMAGE_TOKEN_ESTIMATE = 1_600
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

/**
 * Image type by file signature. Servers mislabel images (a JPEG sent as
 * image/png, or as image/jpg), and the API rejects a type that does not
 * match the bytes.
 */
function sniffImageType(bytes: Buffer): ImageMediaType | undefined {
  const head = bytes.subarray(0, 12).toString('latin1')
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg'
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png'
  if (head.startsWith('GIF8')) return 'image/gif'
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * Binary content as an image the model can see, or else as the path of the
 * file it was saved to. Base64 never reaches the context as text. Null when
 * the block has no data.
 */
async function binaryToBlocks(
  data: unknown,
  mimeType: unknown,
  label: string,
  fileName: string,
  sessionId: string | undefined,
): Promise<ToolResultContentBlockParam[] | null> {
  if (typeof data !== 'string') return null
  const bytes = Buffer.from(data, 'base64')
  const mime = typeof mimeType === 'string' ? mimeType : undefined

  const imageType = mime?.startsWith('image/')
    ? sniffImageType(bytes)
    : undefined
  if (imageType) {
    try {
      // Within the API limits the image keeps its dimensions, so pixel
      // coordinates a tool reports about its screenshot still hold.
      const image = await toolResultImageBlockFromBuffer(bytes, imageType)
      return label ? [{ type: 'text', text: label.trimEnd() }, image] : [image]
    } catch {
      // Not decodable, or too large to shrink: an image the API would refuse
      // fails every later request of the session. Save it instead.
    }
  }

  const described = `${label}Binary content (${mime ?? 'unknown type'}, ${formatFileSize(bytes.length)})`
  try {
    const saved = saveBinaryToolResult(sessionId, fileName, bytes, mime)
    return [{ type: 'text', text: `${described} saved to ${saved.file}` }]
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return [
      {
        type: 'text',
        text: `${described} could not be saved to disk: ${reason}`,
      },
    ]
  }
}

/** Claude Code `transformResultContent`. */
async function toModelBlocks(
  block: McpBlock,
  index: number,
  ctx: McpCallContext,
): Promise<ToolResultContentBlockParam[]> {
  const fileName = `${ctx.toolCallId}-${index}`
  const binary = (data: unknown, mimeType: unknown, label: string) =>
    binaryToBlocks(data, mimeType, label, fileName, ctx.sessionId)

  let blocks: ToolResultContentBlockParam[] | null = null
  switch (block.type) {
    case 'text':
      blocks = [{ type: 'text', text: String(block.text ?? '') }]
      break
    case 'image':
      blocks = await binary(block.data, block.mimeType, '')
      break
    case 'audio':
      blocks = await binary(
        block.data,
        block.mimeType,
        `[Audio from ${ctx.toolName}] `,
      )
      break
    case 'resource': {
      const resource = (block.resource ?? {}) as Record<string, unknown>
      const label = `[Resource from ${ctx.toolName} at ${String(resource.uri)}] `
      blocks =
        typeof resource.text === 'string'
          ? [{ type: 'text', text: label + resource.text }]
          : await binary(resource.blob, resource.mimeType, label)
      break
    }
    case 'resource_link': {
      let text = `[Resource link: ${String(block.name)}] ${String(block.uri)}`
      if (block.description) text += ` (${String(block.description)})`
      blocks = [{ type: 'text', text }]
      break
    }
  }
  return blocks ?? [{ type: 'text', text: `[${block.type} content omitted]` }]
}

/** Whether `text` is `value` serialized, as servers mirror structuredContent. */
function mirrors(text: string, value: unknown): boolean {
  const parsed = parseJson(text)
  return (
    parsed !== undefined && JSON.stringify(parsed) === JSON.stringify(value)
  )
}

/**
 * The text payload of a result: Claude Code `transformMCPResult`, except
 * that an error's text is not replaced by its structuredContent.
 */
function pickText(
  raw: McpCallResult,
  texts: TextBlock[],
): TransformedMcpResult {
  const structured = raw.structuredContent
  const isError = raw.isError === true
  // An error's message is in its text; structuredContent may hold only a code.
  const errorWithText = isError && texts.length > 0
  if (structured !== undefined && !errorWithText) {
    return {
      content: JSON.stringify(structured),
      type: 'structuredContent',
      schema: inferCompactSchema(structured),
    }
  }
  const content = [...texts]
  if (
    structured !== undefined &&
    !texts.some(block => mirrors(block.text, structured))
  ) {
    content.push({ type: 'text', text: JSON.stringify(structured) })
  }
  if (isError && content.length === 0) {
    content.push({ type: 'text', text: 'Unknown error' })
  }
  return {
    content,
    type: 'contentArray',
    schema: inferCompactSchema(content),
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

/** Claude Code `getContentSizeEstimate`: an image counts a flat estimate. */
function estimateBlockTokens(blocks: ToolResultContentBlockParam[]): number {
  return blocks.reduce(
    (n, b) =>
      n +
      (b.type === 'text'
        ? Math.round(b.text.length / 4)
        : IMAGE_TOKEN_ESTIMATE),
    0,
  )
}

/** Claude Code `getTruncationMessage`. */
function getTruncationMessage(): string {
  return `\n\n[OUTPUT TRUNCATED - exceeded ${getMaxMcpOutputTokens()} token limit]

The tool output was truncated. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data. If pagination is not available, inform the user that you are working with truncated output and results may be incomplete.`
}

/**
 * Claude Code `truncateContentBlocks`: blocks in order until `maxChars` is
 * spent. An image that no longer fits is compressed into what is left of the
 * budget, or dropped.
 */
async function truncateContentBlocks(
  blocks: ToolResultContentBlockParam[],
  maxChars: number,
): Promise<ToolResultContentBlockParam[]> {
  const result: ToolResultContentBlockParam[] = []
  let currentChars = 0

  for (const block of blocks) {
    const remainingChars = maxChars - currentChars
    if (block.type === 'text') {
      if (remainingChars <= 0) break
      if (block.text.length <= remainingChars) {
        result.push(block)
        currentChars += block.text.length
      } else {
        result.push({ type: 'text', text: block.text.slice(0, remainingChars) })
        break
      }
      continue
    }

    const imageChars = IMAGE_TOKEN_ESTIMATE * 4
    if (imageChars <= remainingChars) {
      result.push(block)
      currentChars += imageChars
    } else if (remainingChars > 0) {
      try {
        // Base64 is 4/3 the size of the bytes it encodes.
        const compressed = await compressImageBufferToBytes(
          Buffer.from(block.source.data, 'base64'),
          Math.floor(remainingChars * 0.75),
          block.source.media_type,
        )
        const data = compressed.buffer.toString('base64')
        result.push(buildImageBlock(data, compressed.mediaType))
        currentChars += data.length
      } catch {
        // Cannot be made to fit: the image is left out.
      }
    }
  }

  return result
}

/**
 * Claude Code `truncateMcpContentIfNeeded`, deciding on the estimate alone;
 * Claude Code confirms it with a token count from the API.
 */
async function truncateBlocksIfNeeded(
  blocks: ToolResultContentBlockParam[],
): Promise<ToolResultContentBlockParam[]> {
  const maxTokens = getMaxMcpOutputTokens()
  if (estimateBlockTokens(blocks) <= maxTokens) return blocks
  const truncated = await truncateContentBlocks(blocks, maxTokens * 4)
  truncated.push({ type: 'text', text: getTruncationMessage() })
  return truncated
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
 * What the model receives for an MCP call result. The text is persisted
 * when large; images stay inline, next to it.
 */
export async function processMcpToolResult(
  raw: McpCallResult,
  ctx: McpCallContext,
): Promise<ProcessedMcpResult> {
  const isError = raw.isError === true
  const sized = (transformed: TransformedMcpResult): string =>
    (isToolResultsHostOnly(ctx.sessionId) ? processHostOnly : processLocal)(
      transformed,
      ctx.sessionId,
      ctx.toolCallId,
      ctx.toolName,
    )

  if ('toolResult' in raw) {
    const result = sized({
      content: String(raw.toolResult),
      type: 'toolResult',
    })
    return { result, isError }
  }

  const blocks = (
    await Promise.all(
      (raw.content ?? []).map((block, i) => toModelBlocks(block, i, ctx)),
    )
  ).flat()
  const texts = blocks.filter((b): b is TextBlock => b.type === 'text')
  // The API rejects non-text content on an error result.
  const images = isError ? [] : blocks.filter(b => b.type === 'image')

  const transformed = pickText(raw, texts)
  const text = sized(transformed)
  if (images.length === 0) return { result: text, isError }

  // Captions stay next to their images unless the text was replaced, by
  // structuredContent or by the preview of a persisted result.
  const inline =
    transformed.type === 'contentArray' &&
    text === modelText(transformed.content)
  const modelBlocks = await truncateBlocksIfNeeded(
    inline
      ? blocks
      : [...(text ? [{ type: 'text' as const, text }] : []), ...images],
  )
  return {
    result: toolResultBlocksToText(modelBlocks),
    // Truncation may have left no image.
    ...(hasImageBlock(modelBlocks) ? { blocks: modelBlocks } : {}),
    isError,
  }
}
