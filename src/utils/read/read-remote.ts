/**
 * Read for files that live on a remote Worker (SSH host / cloud container).
 *
 * Image, PDF and notebook handling (resize, pdftoppm, `file://` claim-check
 * follow-ups) runs on the agent host against a local path, so those files are
 * copied into host storage first and then go through `readFileCore`.
 */
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import * as path from 'path'
import {
  isImageExtension,
  isNotebookExtension,
  isPdfExtension,
  MAX_OUTPUT_SIZE_BYTES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/api_limits.js'
import { ATTACHMENT_MAX_BYTES } from '../../constants/attachment-types.js'
import { isBinaryContent } from '../../constants/files.js'
import { getScratchDataDir } from '../../core/session-paths.js'
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { saveChatAttachment } from '../chat-uploads.js'
import {
  readFileCore,
  type ReadFileOptions,
  type ReadFileResult,
} from './index.js'
import { fileExtension } from './read-text.js'

const BINARY_SNIFF_CHARS = 8192

/** True when Read must fetch raw bytes instead of UTF-8 text. */
export function needsRemoteBytes(absPath: string): boolean {
  const ext = fileExtension(absPath)
  return (
    isImageExtension(ext) || isPdfExtension(ext) || isNotebookExtension(ext)
  )
}

/**
 * `readText` already decoded the bytes; NUL and C0 control characters survive
 * UTF-8 decoding unchanged, so the local byte sniff still applies.
 */
export function isBinaryText(text: string): boolean {
  return isBinaryContent(Buffer.from(text.slice(0, BINARY_SNIFF_CHARS), 'utf8'))
}

function maxRemoteBytes(ext: string): number {
  if (isPdfExtension(ext)) return PDF_TARGET_RAW_SIZE
  if (isNotebookExtension(ext)) return MAX_OUTPUT_SIZE_BYTES
  return ATTACHMENT_MAX_BYTES.image
}

async function copyToHost(
  bytes: Buffer,
  baseName: string,
  sessionId: string | undefined,
): Promise<string> {
  if (sessionId) {
    const saved = await saveChatAttachment(sessionId, bytes, {
      originalName: baseName,
    })
    return saved.absPath
  }
  const dir = getScratchDataDir('remote-read')
  await fsp.mkdir(dir, { recursive: true })
  const abs = path.join(
    dir,
    `${randomUUID()}${path.extname(baseName).toLowerCase()}`,
  )
  await fsp.writeFile(abs, bytes)
  return abs
}

export async function readRemoteFileViaHost(
  execution: Pick<ExecutionBackend, 'readBytes'>,
  remoteAbs: string,
  displayPath: string,
  options: Omit<ReadFileOptions, 'displayPath' | 'allowOutsideWorkspace'>,
): Promise<ReadFileResult> {
  const bytes = await execution.readBytes(
    remoteAbs,
    maxRemoteBytes(fileExtension(remoteAbs)),
  )
  const hostAbs = await copyToHost(
    bytes,
    path.posix.basename(remoteAbs.replace(/\\/g, '/')),
    options.sessionId,
  )
  let keep = false
  try {
    const result = await readFileCore(path.dirname(hostAbs), hostAbs, {
      ...options,
      displayPath,
      allowOutsideWorkspace: true,
    })
    // Native PDF and session-less image follow-ups reference the copy via
    // file:// and are re-read on every model call.
    keep =
      result.output.type === 'pdf' ||
      (result.output.type === 'image' && !options.sessionId)
    return result
  } finally {
    if (!keep) await fsp.rm(hostAbs, { force: true })
  }
}
