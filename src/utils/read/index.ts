import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import {
  isImageExtension,
  isNotebookExtension,
  isPdfExtension,
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/api_limits.js'
import type { Message, UserContentPart } from '../../core/types.js'
import { resolvePath } from '../../tools/utils.js'
import { coerceSanitizedProjectsPath } from '../../core/session-paths.js'
import {
  fallbackImageForModel,
  isImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../image/resize-buffer.js'
import { mediaTypeForExt, saveChatUpload } from '../chat-uploads.js'
import { formatTextReadBoundaryReminder } from './boundary-reminders.js'
import { FILE_UNCHANGED_STUB } from './read-file-state.js'
import {
  fileExtension,
  formatTextReadForModel,
  readTextFile,
} from './read-text.js'
import { readImageFile } from './read-image.js'
import { readNotebookFile } from './read-notebook.js'
import {
  assertPageRangeSize,
  extractPDFPages,
  formatPdfFileSize,
  getPdfPageCount,
  parsePdfPageRange,
  readPDF,
} from './read-pdf.js'
import type {
  ReadImageOutput,
  ReadOutput,
  ReadPdfOutput,
  ReadPdfPartsOutput,
} from './types.js'

export interface ReadFileOptions {
  offset?: number
  limit?: number
  pages?: string
  /** When set, image follow-ups are offloaded under `.sessions/{id}/uploads/`. */
  sessionId?: string
  /**
   * Provider can ingest native PDF document blocks (Anthropic/Google-style).
   * When false (e.g. openai-compatible Qwen), default Read renders pages via pdftoppm.
   */
  supportsNativePdf?: boolean
  /**
   * FileReadTool: allow absolute paths outside cwd; sandbox still gates access.
   */
  allowOutsideWorkspace?: boolean
  /** Path shown to the model when `filePath` is a host copy of a remote file. */
  displayPath?: string
}

export interface ReadFileResult {
  output: ReadOutput
  /** Extra user messages for multimodal content (images/PDF), `newMessages` pattern. */
  followUpMessages?: Message[]
}

/**
 * Expand a tool path: relative to `cwd`, `~`, or an already-absolute path.
 * Never fails because the result is outside the workspace — permission checks
 * happen afterwards.
 */
export type ResolveFileInCwdOptions = {
  /**
   * When true, absolute paths outside cwd are returned and the caller must
   * enforce sandbox. Default false keeps workspace-only resolution (except
   * session task-output internals).
   */
  allowOutsideWorkspace?: boolean
}

export function resolveFileInCwd(
  cwd: string,
  filePath: string,
  _opts?: ResolveFileInCwdOptions,
): { abs: string; displayPath: string } | { error: string } {
  const resolved = resolvePath(cwd, filePath)
  if ('error' in resolved) {
    return { error: resolved.error || 'Invalid path' }
  }
  let abs = resolved.abs
  const coerced = coerceSanitizedProjectsPath(abs)
  if (coerced && coerced !== abs) {
    try {
      if (!fs.existsSync(abs) && fs.existsSync(coerced)) abs = coerced
    } catch {
      /* keep original */
    }
  }
  const rel = path.relative(path.resolve(cwd), abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { abs, displayPath: filePath }
  }
  const displayPath = rel.split(path.sep).join('/') || path.basename(abs)
  return { abs, displayPath }
}

async function buildPartsFollowUps(
  parts: ReadPdfPartsOutput,
  sessionId?: string,
): Promise<Message[]> {
  const entries = await fs.promises.readdir(parts.file.outputDir)
  const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
  const followUps: Message[] = []
  for (const f of imageFiles) {
    const imgPath = path.join(parts.file.outputDir, f)
    const output = await readImageFile(imgPath, `${parts.file.filePath}#${f}`)
    const followUp = await buildImageFollowUp(output, imgPath, sessionId)
    if (followUp) followUps.push(followUp)
  }
  return followUps
}

async function buildPdfDocumentFollowUp(
  output: ReadPdfOutput,
  absPath: string,
): Promise<Message> {
  // Claim-check: keep bytes on disk; hydrate at API projection (same as images).
  const fileRef = pathToFileURL(absPath).href
  const parts: UserContentPart[] = [
    {
      type: 'text',
      text: wrapReminder(
        `PDF file attached from Read (${output.file.filePath}, ${output.file.pageCount ?? '?'} pages, ${formatPdfFileSize(output.file.originalSize)}).`,
      ),
    },
    {
      type: 'file',
      data: fileRef,
      mediaType: 'application/pdf',
      filename: path.basename(output.file.filePath),
    },
  ]
  return { role: 'user', content: parts, isMeta: true }
}

export async function readFileCore(
  cwd: string,
  filePath: string,
  options?: ReadFileOptions,
): Promise<ReadFileResult> {
  const resolved = resolveFileInCwd(cwd, filePath, {
    allowOutsideWorkspace: options?.allowOutsideWorkspace,
  })
  if ('error' in resolved) throw new Error(resolved.error)
  const abs = resolved.abs
  const displayPath = options?.displayPath ?? resolved.displayPath
  const ext = fileExtension(abs)

  if (isNotebookExtension(ext)) {
    return { output: readNotebookFile(abs, displayPath) }
  }
  if (isImageExtension(ext)) {
    const output = await readImageFile(abs, displayPath)
    const followUp = await buildImageFollowUp(output, abs, options?.sessionId)
    return { output, followUpMessages: followUp ? [followUp] : undefined }
  }
  if (isPdfExtension(ext)) {
    return readPdfCore(abs, displayPath, options)
  }

  return {
    output: readTextFile(abs, displayPath, {
      offset: options?.offset,
      limit: options?.limit,
    }),
  }
}

/**
 * PDF read branch:
 * 1. pages → pdftoppm → image follow-ups
 * 2. pageCount > 10 → error (must use pages)
 * 3. native PDF supported → document follow-up
 * 4. else (Qwen etc.) → auto extract first N pages as images
 */
async function readPdfCore(
  abs: string,
  displayPath: string,
  options?: ReadFileOptions,
): Promise<ReadFileResult> {
  const sessionId = options?.sessionId
  const supportsNativePdf = options?.supportsNativePdf === true

  if (options?.pages) {
    const range = parsePdfPageRange(options.pages)
    if (!range) {
      throw new Error(
        `Invalid pages parameter: "${options.pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
      )
    }
    assertPageRangeSize(range)
    const extractResult = await extractPDFPages(abs, displayPath, {
      firstPage: range.firstPage,
      lastPage: range.lastPage,
      sessionId,
    })
    if (!extractResult.success) {
      throw new Error(extractResult.error.message)
    }
    const followUpMessages = await buildPartsFollowUps(
      extractResult.data,
      sessionId,
    )
    return {
      output: extractResult.data,
      followUpMessages: followUpMessages.length ? followUpMessages : undefined,
    }
  }

  const pageCount = await getPdfPageCount(abs)
  if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
    throw new Error(
      `This PDF has ${pageCount} pages, which is too many to read at once. ` +
        `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
        `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
    )
  }

  if (!supportsNativePdf) {
    const lastPage = Math.min(
      pageCount ?? PDF_MAX_PAGES_PER_READ,
      PDF_MAX_PAGES_PER_READ,
    )
    const extractResult = await extractPDFPages(abs, displayPath, {
      firstPage: 1,
      lastPage,
      sessionId,
    })
    if (!extractResult.success) {
      if (extractResult.error.reason === 'unavailable') {
        throw new Error(
          `Reading PDFs with this model requires rendering pages to images. ${extractResult.error.message}`,
        )
      }
      throw new Error(extractResult.error.message)
    }
    const followUpMessages = await buildPartsFollowUps(
      extractResult.data,
      sessionId,
    )
    return {
      output: extractResult.data,
      followUpMessages: followUpMessages.length ? followUpMessages : undefined,
    }
  }

  const readResult = await readPDF(abs, displayPath)
  if (!readResult.success) {
    throw new Error(readResult.error.message)
  }
  return {
    output: readResult.data,
    followUpMessages: [await buildPdfDocumentFollowUp(readResult.data, abs)],
  }
}

function wrapReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

/**
 * Multimodal follow-up for Read(image). Claim-check: never embed Buffer/base64
 * in session messages — point at the on-disk file (or a session upload copy).
 */
export async function buildImageFollowUp(
  output: ReadImageOutput,
  absPath: string,
  sessionId?: string,
): Promise<Message | null> {
  let imageRef: string
  if (sessionId) {
    const modelBuffer = Buffer.from(output.file.base64, 'base64')
    const modelSaved = await saveChatUpload(
      sessionId,
      modelBuffer,
      output.file.mediaType,
    )
    imageRef = modelSaved.url

    // Keep a separate, higher-detail UI copy. The model attachment above is
    // intentionally constrained by token budget; the UI copy is constrained
    // by dimensions/API bytes and remains replayable after the workspace file
    // is removed.
    const raw = fs.readFileSync(absPath)
    const originalMediaType = mediaTypeForExt(path.extname(absPath))
    let preview: {
      buffer: Buffer
      mediaType: typeof originalMediaType
    }
    try {
      preview = await maybeResizeAndDownsampleImageBuffer(
        raw,
        originalMediaType,
        { maxWidth: 2000, maxHeight: 2000 },
      )
    } catch (err) {
      if (!isImageResizeError(err)) throw err
      preview = await fallbackImageForModel(raw, originalMediaType)
    }
    if (
      preview.mediaType === output.file.mediaType &&
      preview.buffer.equals(modelBuffer)
    ) {
      output.file.previewUrl = modelSaved.url
    } else {
      const previewSaved = await saveChatUpload(
        sessionId,
        preview.buffer,
        preview.mediaType,
      )
      output.file.previewUrl = previewSaved.url
    }
  } else {
    // file:// keeps bytes on disk; hydrateImageBytes loads at API projection.
    imageRef = pathToFileURL(absPath).href
  }

  const parts: UserContentPart[] = [
    {
      type: 'text',
      text: wrapReminder(
        `Image from Read: ${output.file.filePath} (${output.file.mediaType}, ${output.file.originalSize} bytes).`,
      ),
    },
    {
      type: 'image',
      image: imageRef,
      mediaType: output.file.mediaType,
    },
  ]
  return { role: 'user', content: parts, isMeta: true }
}

/** Format Read output as tool result string (for agent tool execute / LLM path). */
export function formatReadOutputAsToolString(output: ReadOutput): string {
  switch (output.type) {
    case 'file_unchanged':
      return FILE_UNCHANGED_STUB
    case 'text':
      if (!output.file.content) {
        return formatTextReadBoundaryReminder(output.file)
      }
      return formatTextReadForModel(output.file)
    case 'image':
      return `[Image: ${output.file.filePath}, ${output.file.mediaType}, ${output.file.originalSize} bytes — image attached in follow-up message]`
    case 'notebook':
      return `${output.file.filePath} (${output.file.cells.length} cells)\n${JSON.stringify(output.file.cells, null, 2)}`
    case 'pdf':
      // Metadata only — document bytes are in the follow-up.
      return `PDF file read: ${output.file.filePath} (${formatPdfFileSize(output.file.originalSize)})`
    case 'parts':
      return `PDF pages extracted: ${output.file.count} page(s) from ${output.file.filePath} (${formatPdfFileSize(output.file.originalSize)})`
    case 'pdf_pages':
      return output.file.text
  }
}

export type { ReadOutput, ReadFileState, ReadFileStateEntry } from './types.js'
export {
  FileTooLargeError,
  MaxFileReadLinesExceededError,
  MaxFileReadTokenExceededError,
  ReadOutputSchema,
} from './types.js'
export { projectReadWireDetails } from './project-wire.js'
export {
  EMPTY_FILE_READ_REMINDER,
  FILE_UNCHANGED_STUB,
  formatTextReadBoundaryReminder,
  offsetBeyondEofReminder,
} from './boundary-reminders.js'
export {
  activeReadFileState,
  clearReadFileState,
  invalidateReadPaths,
  recordReadInState,
  recordWriteInState,
  runWithForkedReadFileState,
  shouldDedupRead,
} from './read-file-state.js'
export {
  formatTextReadForModel,
  addLineNumbers,
  roughTokenEstimate,
} from './read-text.js'
export { readTextFromString } from './read-from-string.js'
export {
  findSimilarFile,
  suggestPathUnderCwd,
  formatFileNotFoundMessage,
} from './path-suggest.js'
export {
  parsePdfPageRange,
  isPdftoppmAvailable,
  popplerInstallHint,
} from './read-pdf.js'
