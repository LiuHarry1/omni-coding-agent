/**
 * PDF read helpers.
 *
 * - Small / native-PDF providers: file:// document follow-up (hydrate at API)
 * - `pages` / non-native providers: `pdftoppm` → JPEG page images → image follow-ups
 */
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_MAX_EXTRACT_SIZE,
  PDF_MAX_PAGES_PER_READ,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/api_limits.js'
import { getSessionDataDir } from '../../session/paths.js'
import type { ReadPdfOutput, ReadPdfPartsOutput } from './types.js'

const execFileAsync = promisify(execFile)

export type PdfPageRange = { firstPage: number; lastPage: number }

export type PdfErrorReason =
  | 'empty'
  | 'too_large'
  | 'password_protected'
  | 'corrupted'
  | 'unknown'
  | 'unavailable'

export type PdfResult<T> =
  | { success: true; data: T }
  | { success: false; error: { reason: PdfErrorReason; message: string } }

export function formatPdfFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Parse a page range — supports `5`, `1-10`, `3-`. */
export function parsePdfPageRange(pages: string): PdfPageRange | null {
  const trimmed = pages.trim()
  if (!trimmed) return null

  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10)
    if (isNaN(first) || first < 1) return null
    return { firstPage: first, lastPage: Infinity }
  }

  const dashIndex = trimmed.indexOf('-')
  if (dashIndex === -1) {
    const page = parseInt(trimmed, 10)
    if (isNaN(page) || page < 1) return null
    return { firstPage: page, lastPage: page }
  }

  const first = parseInt(trimmed.slice(0, dashIndex), 10)
  const last = parseInt(trimmed.slice(dashIndex + 1), 10)
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) {
    return null
  }
  return { firstPage: first, lastPage: last }
}

type PdfParseFn = (buf: Buffer) => Promise<{ numpages?: number; text?: string }>

async function loadPdfParse(): Promise<PdfParseFn | null> {
  try {
    const mod = await import('pdf-parse')
    return (mod.default ?? mod) as PdfParseFn
  } catch {
    return null
  }
}

/** Prefer poppler `pdfinfo`; fall back to pdf-parse. */
export async function getPdfPageCount(absPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [absPath], {
      timeout: 10_000,
      windowsHide: true,
    })
    const match = /^Pages:\s+(\d+)/m.exec(stdout)
    if (match) {
      const count = parseInt(match[1]!, 10)
      if (!isNaN(count)) return count
    }
  } catch {
    // fall through
  }

  try {
    const buf = fs.readFileSync(absPath)
    const pdfParse = await loadPdfParse()
    if (!pdfParse) {
      return Math.max(1, Math.ceil(buf.length / (100 * 1024)))
    }
    const data = await pdfParse(buf)
    return data.numpages ?? null
  } catch {
    return null
  }
}

/**
 * Last-resort text layer extraction: used when the model cannot take a PDF
 * document block and poppler is unavailable to rasterize pages. Scanned PDFs
 * have no text layer and return null.
 */
export async function extractPdfText(
  absPath: string,
  maxChars = 60_000,
): Promise<string | null> {
  try {
    const pdfParse = await loadPdfParse()
    if (!pdfParse) return null
    const data = await pdfParse(fs.readFileSync(absPath))
    const text = data.text?.trim()
    if (!text) return null
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n…[truncated]`
      : text
  } catch {
    return null
  }
}

export async function readPDF(
  absPath: string,
  displayPath: string,
): Promise<PdfResult<ReadPdfOutput>> {
  try {
    if (!fs.existsSync(absPath)) {
      return {
        success: false,
        error: {
          reason: 'unknown',
          message: `file not found: ${displayPath}`,
        },
      }
    }
    const stats = fs.statSync(absPath)
    const originalSize = stats.size
    if (originalSize === 0) {
      return {
        success: false,
        error: {
          reason: 'empty',
          message: `PDF file is empty: ${displayPath}`,
        },
      }
    }
    if (originalSize > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size of ${formatPdfFileSize(PDF_TARGET_RAW_SIZE)}.`,
        },
      }
    }

    const header = Buffer.alloc(5)
    const fd = fs.openSync(absPath, 'r')
    try {
      fs.readSync(fd, header, 0, 5, 0)
    } finally {
      fs.closeSync(fd)
    }
    if (!header.toString('ascii').startsWith('%PDF-')) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: `File is not a valid PDF (missing %PDF- header): ${displayPath}`,
        },
      }
    }

    const pageCount = await getPdfPageCount(absPath)
    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath: displayPath,
          // Bytes stay on disk; follow-up uses file:// and hydrates at API time.
          base64: '',
          originalSize,
          pageCount,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

let pdftoppmAvailable: boolean | undefined

export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined
}

export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  try {
    const { stderr } = await execFileAsync('pdftoppm', ['-v'], {
      timeout: 5000,
      windowsHide: true,
    })
    // pdftoppm prints version to stderr; exit may be 0 or non-zero on some builds
    pdftoppmAvailable = true
    void stderr
  } catch (e: unknown) {
    const err = e as { stderr?: string; code?: number | string }
    // Some Windows builds exit non-zero but still print version on stderr.
    if (typeof err.stderr === 'string' && /pdftoppm/i.test(err.stderr)) {
      pdftoppmAvailable = true
    } else {
      pdftoppmAvailable = false
    }
  }
  return pdftoppmAvailable
}

export function popplerInstallHint(): string {
  return (
    'Page extraction requires poppler-utils (`pdftoppm`). ' +
    'Install with `brew install poppler` on macOS, `apt-get install poppler-utils` on Debian/Ubuntu, ' +
    'or on Windows: `conda install -c conda-forge poppler` / Scoop `scoop install poppler`, then ensure `pdftoppm` is on PATH.'
  )
}

function pdfExtractOutputRoot(sessionId?: string): string {
  if (sessionId) {
    return path.join(getSessionDataDir(sessionId), 'pdf-extract')
  }
  return path.join(os.tmpdir(), 'ai-agent-pdf-extract')
}

/**
 * Extract PDF pages as JPEG images using pdftoppm.
 */
export async function extractPDFPages(
  absPath: string,
  displayPath: string,
  options?: { firstPage?: number; lastPage?: number; sessionId?: string },
): Promise<PdfResult<ReadPdfPartsOutput>> {
  try {
    if (!fs.existsSync(absPath)) {
      return {
        success: false,
        error: {
          reason: 'unknown',
          message: `file not found: ${displayPath}`,
        },
      }
    }
    const stats = fs.statSync(absPath)
    const originalSize = stats.size
    if (originalSize === 0) {
      return {
        success: false,
        error: {
          reason: 'empty',
          message: `PDF file is empty: ${displayPath}`,
        },
      }
    }
    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size for page extraction (${formatPdfFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
        },
      }
    }

    const available = await isPdftoppmAvailable()
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message: `pdftoppm is not installed. ${popplerInstallHint()}`,
        },
      }
    }

    const uuid = randomUUID()
    const outputDir = path.join(
      pdfExtractOutputRoot(options?.sessionId),
      `pdf-${uuid}`,
    )
    await fsp.mkdir(outputDir, { recursive: true })

    const prefix = path.join(outputDir, 'page')
    const args = ['-jpeg', '-r', '100']
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage))
    }
    if (
      options?.lastPage &&
      options.lastPage !== Infinity &&
      Number.isFinite(options.lastPage)
    ) {
      args.push('-l', String(options.lastPage))
    }
    args.push(absPath, prefix)

    try {
      await execFileAsync('pdftoppm', args, {
        timeout: 120_000,
        windowsHide: true,
      })
    } catch (e: unknown) {
      const stderr =
        typeof (e as { stderr?: unknown }).stderr === 'string'
          ? (e as { stderr: string }).stderr
          : e instanceof Error
            ? e.message
            : String(e)
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message:
              'PDF is password-protected. Please provide an unprotected version.',
          },
        }
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF file is corrupted or invalid.',
          },
        }
      }
      return {
        success: false,
        error: { reason: 'unknown', message: `pdftoppm failed: ${stderr}` },
      }
    }

    const entries = await fsp.readdir(outputDir)
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
    if (imageFiles.length === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'pdftoppm produced no output pages. The PDF may be invalid.',
        },
      }
    }

    const rangePages =
      options?.firstPage != null &&
      options?.lastPage != null &&
      options.lastPage !== Infinity
        ? options.lastPage - options.firstPage + 1
        : imageFiles.length
    if (
      rangePages > PDF_MAX_PAGES_PER_READ &&
      imageFiles.length > PDF_MAX_PAGES_PER_READ
    ) {
      // Safety: if open-ended range produced too many pages, keep first N.
      const keep = imageFiles.slice(0, PDF_MAX_PAGES_PER_READ)
      for (const f of imageFiles.slice(PDF_MAX_PAGES_PER_READ)) {
        await fsp.unlink(path.join(outputDir, f)).catch(() => {})
      }
      return {
        success: true,
        data: {
          type: 'parts',
          file: {
            filePath: displayPath,
            originalSize,
            count: keep.length,
            outputDir,
          },
        },
      }
    }

    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath: displayPath,
          originalSize,
          count: imageFiles.length,
          outputDir,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/** Clamp a parsed range to max pages per request; throw if invalid size. */
export function assertPageRangeSize(range: PdfPageRange): void {
  if (range.lastPage === Infinity) return
  const count = range.lastPage - range.firstPage + 1
  if (count > PDF_MAX_PAGES_PER_READ) {
    throw new Error(
      `Page range exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request (requested ${count}). Please use a smaller range.`,
    )
  }
}

export async function tryGetPdfReference(
  absPath: string,
  displayPath: string,
): Promise<{
  type: 'pdf_reference'
  filename: string
  displayPath: string
  pageCount: number
  fileSize: number
} | null> {
  try {
    const stat = fs.statSync(absPath)
    const pageCount = await getPdfPageCount(absPath)
    const effective = pageCount ?? Math.ceil(stat.size / (100 * 1024))
    if (effective <= PDF_AT_MENTION_INLINE_THRESHOLD) return null
    return {
      type: 'pdf_reference',
      filename: absPath,
      displayPath,
      pageCount: effective,
      fileSize: stat.size,
    }
  } catch {
    return null
  }
}
