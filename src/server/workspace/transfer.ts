import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import multer from 'multer'
// archiver v8 is ESM-only: named ZipArchive class, no default export (@types/archiver is v7-shaped).
import * as archiverPkg from 'archiver'
import { resolvePath, assertSafeName } from './path-safety.js'
import { invalidateFileSearchCache } from './fs-ops.js'

type ZipArchiveInstance = import('stream').PassThrough & {
  on(event: 'error', listener: () => void): ZipArchiveInstance
  pipe(destination: ServerResponse): ZipArchiveInstance
  directory(dirpath: string, destpath: false): ZipArchiveInstance
  finalize(): Promise<void>
}

const ZipArchive = (
  archiverPkg as unknown as {
    ZipArchive: new (options?: {
      zlib?: { level?: number }
    }) => ZipArchiveInstance
  }
).ZipArchive

/**
 * Binary upload / download for the workspace module.
 *
 * Sits beside fs-ops.ts (which only handles UTF-8 text) and gives the IDE a
 * real binary channel:
 *   - POST /workspace/upload    multipart/form-data, fields: `dir` + `file`(s)
 *   - GET  /workspace/download?path=   streams a file, or zips a directory
 *
 * Callers should pass `resolveSafe` (router `safe()`) so paths honor the same
 * workspace / dontAsk boundary as list/read/write. Without it, paths fall
 * back to unsandboxed `resolvePath` (local single-user only).
 */

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB per file

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

export function mimeTypeFor(fileName: string): string {
  return (
    MIME_BY_EXT[path.extname(fileName).toLowerCase()] ||
    'application/octet-stream'
  )
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * multipart filenames arrive latin1-decoded from busboy; re-decode as UTF-8 so
 * non-ASCII names (Chinese, emoji, …) survive the round-trip.
 */
function decodeOriginalName(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8')
  } catch {
    return name
  }
}

/** `report.pdf` next to an existing `report.pdf` → `report (1).pdf`. */
function uniqueDest(dir: string, name: string): string {
  let candidate = path.join(dir, name)
  if (!fs.existsSync(candidate)) return candidate
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  for (let i = 1; ; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

/** rename, falling back to copy+unlink when temp and target are on different volumes. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.promises.copyFile(src, dest)
      await fs.promises.unlink(src)
    } else {
      throw err
    }
  }
}

interface MulterFile {
  path: string
  originalname: string
  size: number
}

/** One uploaded part, spooled to a temp file on this machine. */
export interface ReceivedFile {
  /** Temp file path. */
  path: string
  /** Decoded original name; null when it is not a safe single segment. */
  name: string | null
  size: number
}

export interface ReceivedUpload {
  fields: Record<string, string | undefined>
  files: ReceivedFile[]
  /** Remove every temp file that is still on disk. */
  cleanup: () => Promise<void>
}

export interface ReceiveUploadOptions {
  maxFileBytes?: number
  maxFiles?: number
  maxFields?: number
  preservePath?: boolean
}

/** Parse a multipart body (`file` parts + text fields) into temp files. */
export async function receiveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  options: ReceiveUploadOptions = {},
): Promise<ReceivedUpload> {
  const maxFiles = options.maxFiles
  const maxFields = options.maxFields
  const uploader = multer({
    preservePath: options.preservePath ?? false,
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: {
      fileSize: options.maxFileBytes ?? MAX_UPLOAD_BYTES,
      ...(maxFiles === undefined ? {} : { files: maxFiles }),
      ...(maxFields === undefined ? {} : { fields: maxFields }),
      ...(maxFiles === undefined || maxFields === undefined
        ? {}
        : { parts: maxFiles + maxFields }),
    },
  }).array('file', maxFiles)
  // multer is connect-style middleware; it works directly on the raw req/res.
  const raw = await new Promise<MulterFile[]>((resolve, reject) => {
    uploader(req as any, res as any, (err: unknown) => {
      if (err) reject(err)
      else resolve(((req as any).files as MulterFile[]) || [])
    })
  })
  const files = raw.map(f => {
    const name = decodeOriginalName(f.originalname)
    let safe: string | null = name
    try {
      assertSafeName(name)
    } catch {
      safe = null
    }
    return { path: f.path, name: safe, size: f.size }
  })
  return {
    fields: ((req as any).body ?? {}) as Record<string, string | undefined>,
    files,
    cleanup: async () => {
      await Promise.allSettled(files.map(f => fs.promises.unlink(f.path)))
    },
  }
}

export type ResolveSafePath = (
  input: string,
  access?: 'read' | 'write',
) => string

export async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  resolveSafe?: ResolveSafePath,
): Promise<void> {
  const { fields, files, cleanup } = await receiveUpload(req, res)

  const resolveTarget = (input: string, access: 'read' | 'write') =>
    resolveSafe ? resolveSafe(input, access) : resolvePath(input, root)

  try {
    const dirField = fields.dir
    if (!dirField) {
      await cleanup()
      sendJSON(res, 400, { error: "Missing 'dir' field" })
      return
    }
    if (files.length === 0) {
      sendJSON(res, 400, { error: 'No files in upload' })
      return
    }

    const targetDir = resolveTarget(dirField, 'write')
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      await cleanup()
      sendJSON(res, 404, { error: `Target directory not found: ${targetDir}` })
      return
    }

    const uploaded: Array<{ name: string; path: string; size: number }> = []
    for (const f of files) {
      const name = f.name
      if (!name) {
        await fs.promises.unlink(f.path).catch(() => {})
        continue
      }
      const dest = uniqueDest(targetDir, name)
      await moveFile(f.path, dest)
      uploaded.push({ name: path.basename(dest), path: dest, size: f.size })
    }

    sendJSON(res, 200, { dir: targetDir, uploaded })
    invalidateFileSearchCache()
  } catch (err) {
    await cleanup()
    if (!res.headersSent) {
      const status =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'EACCES'
          ? 403
          : 500
      sendJSON(res, status, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export async function handleDownload(
  res: ServerResponse,
  root: string,
  pathParam: string | null,
  resolveSafe?: ResolveSafePath,
): Promise<void> {
  if (!pathParam) {
    sendJSON(res, 400, { error: "Missing 'path'" })
    return
  }
  let target: string
  try {
    target = resolveSafe
      ? resolveSafe(pathParam, 'read')
      : resolvePath(pathParam, root)
  } catch (err) {
    const status =
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'EACCES'
        ? 403
        : 400
    sendJSON(res, status, {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (!fs.existsSync(target)) {
    sendJSON(res, 404, { error: `Not found: ${target}` })
    return
  }

  const stat = fs.statSync(target)

  // Directory → stream a zip built on the fly.
  if (stat.isDirectory()) {
    const zipName = `${path.basename(target) || 'workspace'}.zip`
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(zipName),
    })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    archive.on('error', () => res.destroy())
    archive.pipe(res)
    archive.directory(target, false)
    await archive.finalize()
    return
  }

  // File → stream it as an attachment.
  res.writeHead(200, {
    'Content-Type': mimeTypeFor(target),
    'Content-Length': String(stat.size),
    'Content-Disposition': contentDisposition(path.basename(target)),
  })
  const stream = fs.createReadStream(target)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * RFC 5987 Content-Disposition with both a plain `filename` (ASCII fallback)
 * and `filename*` (UTF-8) so non-ASCII names download with the right name.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  const encoded = encodeURIComponent(name)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
