/**
 * Send one CDP command through BrowserBackend, with the deny list and
 * overflow-to-file behaviour (CDP_INLINE_MAX_CHARS, or always for Profiler.stop).
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { CDP_INLINE_MAX_CHARS } from './limits.js'
import { denyCdpMethod } from './cdp-policy.js'
import { getBrowserLogsSessionDir } from '../session/paths.js'
import { BrowserError, type BrowserBackend } from './types.js'

export type CdpCommandResult =
  | { overflow: false; result: unknown; text: string }
  | { overflow: true; filePath: string; sizeBytes: number; reason: string }

function cdpFileName(method: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = method.replace(/[^a-zA-Z0-9.-]/g, '_')
  const prefix = method === 'Profiler.stop' ? 'cdp-profile' : 'cdp-response'
  return `${prefix}-${safe}-${stamp}.json`
}

async function writeCdpFile(
  method: string,
  text: string,
  sessionId?: string,
): Promise<{ filePath: string; sizeBytes: number }> {
  const dir = sessionId
    ? getBrowserLogsSessionDir(sessionId)
    : path.join(os.tmpdir(), 'ai-agent-cdp')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, cdpFileName(method))
  await fs.writeFile(filePath, text, 'utf8')
  return { filePath, sizeBytes: Buffer.byteLength(text, 'utf8') }
}

export async function sendCdpCommand(
  backend: BrowserBackend,
  targetId: string,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<CdpCommandResult> {
  const denied = denyCdpMethod(method)
  if (denied) throw new BrowserError(denied)

  const result = await backend.send(targetId, method.trim(), params ?? {})
  const text = JSON.stringify(result ?? {}, null, 2)
  const overflow =
    method.trim() === 'Profiler.stop' || text.length > CDP_INLINE_MAX_CHARS
  if (!overflow) return { overflow: false, result, text }

  const { filePath, sizeBytes } = await writeCdpFile(
    method.trim(),
    text,
    sessionId,
  )
  const reason =
    method.trim() === 'Profiler.stop'
      ? 'Profile data can be large, so it was saved to a file instead of being inlined. Use Read/Grep on that path with offset+limit — do not Bash the whole file into context.'
      : `CDP response exceeded ${CDP_INLINE_MAX_CHARS} characters, so it was saved to a file instead of being inlined. Do not dump the whole file via Bash/python. Prefer a narrower Runtime.evaluate expression, browser_snapshot, or browser_get_text. If you must inspect the file, use Grep or Read with offset+limit.`
  return { overflow: true, filePath, sizeBytes, reason }
}
