import { z } from 'zod'

export type ReadTextOutput = {
  type: 'text'
  file: {
    filePath: string
    content: string
    numLines: number
    startLine: number
    totalLines: number
  }
}

export type ReadImageOutput = {
  type: 'image'
  file: {
    filePath: string
    base64: string
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    originalSize: number
    /** Authenticated session-scoped UI preview; never contains image bytes. */
    previewUrl?: string
  }
}

export type ReadNotebookOutput = {
  type: 'notebook'
  file: {
    filePath: string
    cells: unknown[]
  }
}

export type ReadPdfOutput = {
  type: 'pdf'
  file: {
    filePath: string
    base64: string
    originalSize: number
    pageCount: number | null
  }
}

/** @deprecated Prefer `parts` (pdftoppm images). Kept for legacy wire hydrate. */
export type ReadPdfPagesOutput = {
  type: 'pdf_pages'
  file: {
    filePath: string
    pages: string
    text: string
    pageCount: number
  }
}

/** `parts` — PDF pages rendered to JPEG under `outputDir`. */
export type ReadPdfPartsOutput = {
  type: 'parts'
  file: {
    filePath: string
    originalSize: number
    count: number
    outputDir: string
  }
}

/** Same path+range Read while mtime unchanged — model should reuse earlier tool_result. */
export type ReadFileUnchangedOutput = {
  type: 'file_unchanged'
  file: { filePath: string }
}

export type ReadOutput =
  | ReadTextOutput
  | ReadImageOutput
  | ReadNotebookOutput
  | ReadPdfOutput
  | ReadPdfPagesOutput
  | ReadPdfPartsOutput
  | ReadFileUnchangedOutput

/** Loose schema for UI/wire validation. */
export const ReadOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    file: z.object({
      filePath: z.string(),
      content: z.string(),
      numLines: z.number(),
      startLine: z.number(),
      totalLines: z.number(),
    }),
  }),
  z.object({
    type: z.literal('image'),
    file: z.object({
      filePath: z.string(),
      base64: z.string(),
      mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      originalSize: z.number(),
      previewUrl: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('notebook'),
    file: z.object({
      filePath: z.string(),
      cells: z.array(z.unknown()),
    }),
  }),
  z.object({
    type: z.literal('pdf'),
    file: z.object({
      filePath: z.string(),
      base64: z.string(),
      originalSize: z.number(),
      pageCount: z.number().nullable(),
    }),
  }),
  z.object({
    type: z.literal('parts'),
    file: z.object({
      filePath: z.string(),
      originalSize: z.number(),
      count: z.number(),
      outputDir: z.string(),
    }),
  }),
  z.object({
    type: z.literal('pdf_pages'),
    file: z.object({
      filePath: z.string(),
      pages: z.string(),
      text: z.string(),
      pageCount: z.number(),
    }),
  }),
  z.object({
    type: z.literal('file_unchanged'),
    file: z.object({
      filePath: z.string(),
    }),
  }),
])

export class FileTooLargeError extends Error {
  constructor(
    public sizeBytes: number,
    public maxBytes: number,
  ) {
    super(
      `File content (${Math.round(sizeBytes / 1024)} KB) exceeds maximum allowed size (${Math.round(maxBytes / 1024)} KB). ` +
        `Use offset and limit parameters to read specific portions of the file, or search with grep instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
  }
}

export class MaxFileReadLinesExceededError extends Error {
  constructor(
    public totalLines: number,
    public maxLines: number,
  ) {
    super(
      `File has ${totalLines} lines (limit ${maxLines}). Use offset and limit parameters to read specific portions, or search with grep instead of reading the whole file.`,
    )
    this.name = 'MaxFileReadLinesExceededError'
  }
}

export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (~${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). ` +
        `Use offset and limit parameters to read specific portions of the file, or search with grep instead of reading the whole file.`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

/** Per-path cache entry for Read dedup + Edit/Write bookkeeping. */
export interface ReadFileStateEntry {
  content: string
  timestamp: number
  /**
   * Present when this entry came from the Read tool (enables file_unchanged dedup).
   * Edit/Write leave these undefined so dedup never matches against post-edit mtime alone.
   */
  offset?: number
  limit?: number
  /**
   * `content` is not the file's text as it is on disk (a line range, a
   * truncated prefix, or a serialized non-text read), so it cannot be diffed
   * against the file to report outside changes.
   */
  isPartialView?: boolean
}

/** Session map: absolute path → last read/write bookkeeping. */
export type ReadFileState = Map<string, ReadFileStateEntry>
