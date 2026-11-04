import * as fs from 'fs'
import * as path from 'path'
import type { ServerResponse } from 'http'
import { FsOpError } from './fs-ops.js'

/** Max artifact size for inline preview. */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
}

export interface RemotePreviewFs {
  realpath(filePath: string): Promise<string>
  inspectPath(filePath: string): Promise<{
    type: 'missing' | 'file' | 'dir' | 'symlink' | 'other'
    size: number
  }>
  readHead(filePath: string, maxBytes: number): Promise<Buffer>
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function contentDispositionInline(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  const encoded = encodeURIComponent(name)
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function previewHeaders(
  name: string,
  size: number,
  contentType: string,
): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(size),
    'Content-Disposition': contentDispositionInline(name),
    // Previewed HTML is workspace-controlled. Keep scripts functional for
    // offline charts while forcing an opaque origin so direct navigation
    // cannot read the Coding Agent SPA's localStorage/JWT.
    'Content-Security-Policy': 'sandbox allow-scripts allow-downloads',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}

function contentTypeForPreview(pathParam: string): string {
  const ext = path.posix.extname(pathParam).toLowerCase()
  const contentType = PREVIEW_CONTENT_TYPES[ext]
  if (!contentType) {
    throw new FsOpError(
      'EINVAL',
      'Preview only supports HTML, PDF, PNG, JPEG, GIF, WebP, and AVIF files',
    )
  }
  return contentType
}

function isWithinPosixRoot(target: string, root: string): boolean {
  const relative = path.posix.relative(root, target)
  return relative === '' || (!relative.startsWith('../') && relative !== '..')
}

/** Public agent base URL for preview links (matches deploy AGENT_PUBLIC_URL). */
export function getPreviewBaseUrl(): string | undefined {
  const raw = process.env.AGENT_PUBLIC_URL?.trim()
  if (!raw) return undefined
  return raw.replace(/\/$/, '')
}

/**
 * Stream a workspace HTML, PDF, or image file for browser preview.
 * Maps search2chart-mcp's localhost HTTP serve to `/workspace/preview?path=`.
 */
export async function handlePreview(
  res: ServerResponse,
  pathParam: string | null,
  safe: (input: string, access?: 'read' | 'write') => string,
): Promise<void> {
  if (!pathParam) {
    sendJSON(res, 400, { error: "Missing 'path'" })
    return
  }

  let contentType: string
  try {
    contentType = contentTypeForPreview(pathParam)
  } catch (err) {
    sendJSON(res, 400, {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const target = safe(pathParam)
  if (!fs.existsSync(target)) {
    sendJSON(res, 404, { error: `Not found: ${target}` })
    return
  }

  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    sendJSON(res, 400, { error: 'Not a file' })
    return
  }
  if (stat.size > MAX_PREVIEW_BYTES) {
    throw new FsOpError(
      'E2BIG',
      `File too large for preview (max ${MAX_PREVIEW_BYTES} bytes)`,
    )
  }

  res.writeHead(
    200,
    previewHeaders(path.basename(target), stat.size, contentType),
  )
  const stream = fs.createReadStream(target)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * Serve HTML, PDF, or an image from a cloud/SSH execution environment. The
 * caller authorizes access to the environment; this function additionally
 * confines the path to that environment's workspace root, including after
 * symlink resolution.
 */
export async function handleRemotePreview(
  res: ServerResponse,
  pathParam: string | null,
  port: RemotePreviewFs,
  workspaceRoot: string,
): Promise<void> {
  try {
    if (!pathParam) throw new FsOpError('EINVAL', "Missing 'path'")
    const contentType = contentTypeForPreview(pathParam)
    const root = await port.realpath(workspaceRoot)
    const requested = path.posix.isAbsolute(pathParam)
      ? path.posix.normalize(pathParam)
      : path.posix.resolve(root, pathParam)
    const inspected = await port.inspectPath(requested)
    if (inspected.type === 'symlink') {
      throw new FsOpError('EACCES', 'Artifact preview does not follow symlinks')
    }
    if (inspected.type !== 'file') {
      throw new FsOpError('ENOENT', `Not found: ${requested}`)
    }
    const target = await port.realpath(requested)
    if (!isWithinPosixRoot(target, root)) {
      throw new FsOpError(
        'EACCES',
        `Refused: "${target}" is outside the environment workspace "${root}"`,
      )
    }

    const size = inspected.size
    if (size > MAX_PREVIEW_BYTES) {
      throw new FsOpError(
        'E2BIG',
        `File too large for preview (max ${MAX_PREVIEW_BYTES} bytes)`,
      )
    }
    const body = await port.readHead(target, MAX_PREVIEW_BYTES + 1)
    if (body.length > MAX_PREVIEW_BYTES) {
      throw new FsOpError(
        'E2BIG',
        `File too large for preview (max ${MAX_PREVIEW_BYTES} bytes)`,
      )
    }
    res.writeHead(
      200,
      previewHeaders(path.posix.basename(target), body.length, contentType),
    )
    res.end(body)
  } catch (err) {
    if (err instanceof FsOpError) throw err
    const code =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof err.code === 'string'
        ? err.code
        : 'EIO'
    throw new FsOpError(code, err instanceof Error ? err.message : String(err))
  }
}
