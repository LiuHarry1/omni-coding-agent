import * as fs from 'fs'
import * as path from 'path'
import {
  extractAtMentionedFiles,
  parseAtMentionedFileLines,
} from './extract-mentions.js'
import type { Attachment } from './types.js'
import type { ReadFileState } from '../read/types.js'
import { readFileCore, resolveFileInCwd } from '../read/index.js'
import { listDirectoryEntries } from '../fs/list-dir.js'
import {
  readTextFileTruncated,
  isFileWithinReadSizeLimit,
} from '../read/read-text.js'
import { tryGetPdfReference } from '../read/read-pdf.js'
import { isPdfExtension } from '../../constants/api_limits.js'
import { FileTooLargeError } from '../read/types.js'
import type { ReadOutput } from '../read/types.js'

function serializeReadOutput(output: ReadOutput): string {
  if (output.type === 'text') return output.file.content
  if (output.type === 'notebook') return JSON.stringify(output.file.cells)
  return JSON.stringify(output)
}

export async function generateFileAttachment(
  cwd: string,
  mentionPath: string,
  readFileState: ReadFileState,
  options?: { offset?: number; limit?: number },
): Promise<Attachment | null> {
  const { filename, lineStart, lineEnd } =
    parseAtMentionedFileLines(mentionPath)
  const resolved = resolveFileInCwd(cwd, filename)
  if ('error' in resolved) return null
  const { abs, displayPath } = resolved

  try {
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      return {
        type: 'directory',
        path: abs,
        displayPath,
        content: listDirectoryEntries(abs, displayPath),
      }
    }
  } catch {
    return null
  }

  const pdfRef = await tryGetPdfReference(abs, displayPath)
  if (pdfRef) return pdfRef

  const existing = readFileState.get(abs)
  if (existing) {
    try {
      const mtimeMs = fs.statSync(abs).mtimeMs
      if (existing.timestamp <= mtimeMs && mtimeMs === existing.timestamp) {
        let content: ReadOutput
        try {
          content = JSON.parse(existing.content) as ReadOutput
        } catch {
          content = {
            type: 'text',
            file: {
              filePath: displayPath,
              content: existing.content,
              numLines: existing.content.split('\n').length,
              startLine: lineStart ?? 1,
              totalLines: existing.content.split('\n').length,
            },
          }
        }
        return {
          type: 'already_read_file',
          filename: abs,
          displayPath,
          content,
        }
      }
    } catch {
      // fall through
    }
  }

  const limit = lineEnd && lineStart ? lineEnd - lineStart + 1 : options?.limit
  const offset = lineStart ?? options?.offset

  if (!isFileWithinReadSizeLimit(abs) && !isPdfExtension(path.extname(abs))) {
    try {
      const truncated = readTextFileTruncated(abs, displayPath, {
        offset,
        limit,
      })
      readFileState.set(abs, {
        content: truncated.file.content,
        timestamp: Math.floor(fs.statSync(abs).mtimeMs),
        isPartialView: true,
      })
      return {
        type: 'file',
        filename: abs,
        displayPath,
        content: truncated,
        truncated: true,
      }
    } catch {
      return null
    }
  }

  try {
    const { output } = await readFileCore(cwd, filename, { offset, limit })
    const wholeText =
      output.type === 'text' && offset === undefined && limit === undefined
    readFileState.set(abs, {
      content: serializeReadOutput(output),
      timestamp: Math.floor(fs.statSync(abs).mtimeMs),
      ...(wholeText ? {} : { isPartialView: true }),
    })
    return {
      type: 'file',
      filename: abs,
      displayPath,
      content: output,
    }
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      try {
        const truncated = readTextFileTruncated(abs, displayPath, {
          offset,
          limit,
        })
        return {
          type: 'file',
          filename: abs,
          displayPath,
          content: truncated,
          truncated: true,
        }
      } catch {
        return null
      }
    }
    return null
  }
}

export async function getAttachmentsForInput(
  cwd: string,
  input: string,
  readFileState: ReadFileState,
): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) return []

  const results = await Promise.all(
    files.map(file => generateFileAttachment(cwd, file, readFileState)),
  )
  return results.filter((r): r is Attachment => r != null)
}

/** processAtMentionedFiles */
export async function processAtMentionedFiles(
  input: string,
  ctx: { cwd: string; readFileState: ReadFileState },
): Promise<Attachment[]> {
  return getAttachmentsForInput(ctx.cwd, input, ctx.readFileState)
}
