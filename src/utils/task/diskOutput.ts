/**
 * Task output on disk (simplified: no O_NOFOLLOW / symlink init).
 */
import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  statSync,
} from 'fs'
import { join } from 'path'
import { getSessionDataDir } from '../../session/paths.js'

export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

let _sessionId: string | undefined
let _taskOutputDir: string | undefined

/** Bind session before minting task output paths (chat turn / spawn). */
export function setTaskSessionId(sessionId: string | undefined): void {
  if (_sessionId === sessionId) return
  _sessionId = sessionId
  _taskOutputDir = undefined
}

export function getTaskSessionId(): string {
  return _sessionId ?? 'default'
}

export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    _taskOutputDir = join(getSessionDataDir(getTaskSessionId()), 'tasks')
  }
  return _taskOutputDir
}

/** Test helper — clears the memoized dir. */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined
  _sessionId = undefined
}

function ensureOutputDir(): void {
  mkdirSync(getTaskOutputDir(), { recursive: true })
}

export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

export function initTaskOutput(taskId: string): void {
  ensureOutputDir()
  const p = getTaskOutputPath(taskId)
  if (!existsSync(p)) {
    appendFileSync(p, '', 'utf8')
  }
}

/**
 * Append chunk to task output file (sync; coarse 5GB cap).
 */
export function appendTaskOutput(taskId: string, content: string): void {
  if (!content) return
  ensureOutputDir()
  const p = getTaskOutputPath(taskId)
  try {
    const size = existsSync(p) ? statSync(p).size : 0
    if (size > MAX_TASK_OUTPUT_BYTES) return
    if (size + Buffer.byteLength(content, 'utf8') > MAX_TASK_OUTPUT_BYTES) {
      appendFileSync(
        p,
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
        'utf8',
      )
      return
    }
  } catch {
    /* create below */
  }
  appendFileSync(p, content, 'utf8')
}

/** Tail of file (last maxBytes), or full file if smaller. */
export function getTaskOutput(
  taskId: string,
  maxBytes = 8 * 1024 * 1024,
): string {
  const p = getTaskOutputPath(taskId)
  if (!existsSync(p)) return ''
  try {
    const buf = readFileSync(p)
    if (buf.length <= maxBytes) return buf.toString('utf8')
    return buf.subarray(buf.length - maxBytes).toString('utf8')
  } catch {
    return ''
  }
}

export function getTaskOutputSize(taskId: string): number {
  const p = getTaskOutputPath(taskId)
  try {
    return existsSync(p) ? statSync(p).size : 0
  } catch {
    return 0
  }
}

/** Read from byte offset to end (for delta polling). */
export function getTaskOutputDelta(
  taskId: string,
  offset: number,
): { content: string; newOffset: number } {
  const p = getTaskOutputPath(taskId)
  if (!existsSync(p)) return { content: '', newOffset: offset }
  try {
    const buf = readFileSync(p)
    if (offset >= buf.length) return { content: '', newOffset: offset }
    const slice = buf.subarray(offset)
    return {
      content: slice.toString('utf8'),
      newOffset: buf.length,
    }
  } catch {
    return { content: '', newOffset: offset }
  }
}

export function cleanupTaskOutput(taskId: string): void {
  const p = getTaskOutputPath(taskId)
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/** Evict after notification — keep file for Read; no-op cleanup optional later. */
export async function evictTaskOutput(_taskId: string): Promise<void> {
  // Keep the file for TaskOutput/Read rather than evicting it.
}
