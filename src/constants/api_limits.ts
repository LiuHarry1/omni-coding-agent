/** Aligned with `constants/apiLimits.ts` + `FileReadTool/limits.ts`. */

export const MAX_OUTPUT_SIZE_BYTES = 256 * 1024
export const DEFAULT_FILE_READ_MAX_TOKENS = 25_000
export const MAX_LINES_TO_READ = 2000

export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

/**
 * Model-facing Read images (matplotlib charts, diagrams, PDF pages, scans).
 * Sized from the file-read maxTokens budget (~25k), not the
 * much tighter screenshot budget. Invoice/scan JPEGs never fit ~15KB.
 */
export const READ_IMAGE_MAX_WIDTH = 1600
export const READ_IMAGE_MAX_HEIGHT = 1600
export const READ_IMAGE_TOKEN_BUDGET = DEFAULT_FILE_READ_MAX_TOKENS

export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10
export const PDF_MAX_PAGES_PER_READ = 20
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024
/** Max raw PDF size for pdftoppm page extraction. */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024

export const MAX_DIR_ENTRIES = 1000

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.replace(/^\./, '').toLowerCase())
}

export function isPdfExtension(ext: string): boolean {
  return ext.replace(/^\./, '').toLowerCase() === 'pdf'
}

export function isNotebookExtension(ext: string): boolean {
  return ext.replace(/^\./, '').toLowerCase() === 'ipynb'
}
