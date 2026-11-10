import * as fs from 'fs'
import * as path from 'path'
import type { ServerResponse } from 'http'
import { FsOpError } from './fs-ops.js'

/** Max artifact size for inline preview. */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
export const MAX_OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024

const DEFAULT_GOTENBERG_TIMEOUT_SECONDS = 60

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

const OFFICE_PREVIEW_EXTENSIONS = new Set(['.pptx'])

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

function previewExtension(pathParam: string): string {
  return path.posix.extname(pathParam).toLowerCase()
}

function contentTypeForPreview(pathParam: string): string {
  const ext = previewExtension(pathParam)
  if (OFFICE_PREVIEW_EXTENSIONS.has(ext)) return 'application/pdf'
  const contentType = PREVIEW_CONTENT_TYPES[ext]
  if (!contentType) {
    throw new FsOpError(
      'EINVAL',
      'Preview only supports PPTX, HTML, PDF, PNG, JPEG, GIF, WebP, and AVIF files',
    )
  }
  return contentType
}

function maxPreviewBytes(pathParam: string): number {
  return OFFICE_PREVIEW_EXTENSIONS.has(previewExtension(pathParam))
    ? MAX_OFFICE_PREVIEW_BYTES
    : MAX_PREVIEW_BYTES
}

function previewOutputName(filePath: string): string {
  const name = path.posix.basename(filePath)
  return OFFICE_PREVIEW_EXTENSIONS.has(previewExtension(filePath))
    ? name.replace(/\.[^.]+$/, '.pdf')
    : name
}

export async function convertOfficePreviewToPdf(
  body: Buffer,
  fileName: string,
): Promise<Buffer> {
  const configuredUrl = process.env.GOTENBERG_URL?.trim()
  if (!configuredUrl) {
    throw new FsOpError(
      'EIO',
      'PPTX preview is not configured: set GOTENBERG_URL to a Gotenberg service',
    )
  }
  const baseUrl = configuredUrl.replace(/\/+$/, '')
  const timeoutSeconds = Number.parseInt(
    process.env.GOTENBERG_TIMEOUT_SECONDS || '',
    10,
  )
  const timeoutMs =
    (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds
      : DEFAULT_GOTENBERG_TIMEOUT_SECONDS) * 1000
  const form = new FormData()
  form.append(
    'files',
    new Blob([Uint8Array.from(body)], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }),
    fileName,
  )

  let response: Response
  try {
    response = await fetch(`${baseUrl}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new FsOpError(
      'EIO',
      `PPTX preview conversion failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new FsOpError(
      'EIO',
      `PPTX preview conversion returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('application/pdf')) {
    throw new FsOpError(
      'EIO',
      `PPTX preview conversion returned ${contentType || 'an unknown content type'}`,
    )
  }
  const converted = Buffer.from(await response.arrayBuffer())
  if (converted.length > MAX_OFFICE_PREVIEW_BYTES) {
    throw new FsOpError(
      'E2BIG',
      `Converted preview is too large (max ${MAX_OFFICE_PREVIEW_BYTES} bytes)`,
    )
  }
  return converted
}

async function preparePreviewBody(
  body: Buffer,
  filePath: string,
): Promise<Buffer> {
  return OFFICE_PREVIEW_EXTENSIONS.has(previewExtension(filePath))
    ? convertOfficePreviewToPdf(body, path.posix.basename(filePath))
    : body
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
  const maxBytes = maxPreviewBytes(pathParam)
  if (stat.size > maxBytes) {
    throw new FsOpError(
      'E2BIG',
      `File too large for preview (max ${maxBytes} bytes)`,
    )
  }

  if (OFFICE_PREVIEW_EXTENSIONS.has(previewExtension(pathParam))) {
    const body = await preparePreviewBody(fs.readFileSync(target), pathParam)
    res.writeHead(
      200,
      previewHeaders(previewOutputName(target), body.length, contentType),
    )
    res.end(body)
    return
  }

  res.writeHead(
    200,
    previewHeaders(previewOutputName(target), stat.size, contentType),
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
    const maxBytes = maxPreviewBytes(pathParam)
    if (size > maxBytes) {
      throw new FsOpError(
        'E2BIG',
        `File too large for preview (max ${maxBytes} bytes)`,
      )
    }
    const source = await port.readHead(target, maxBytes + 1)
    if (source.length > maxBytes) {
      throw new FsOpError(
        'E2BIG',
        `File too large for preview (max ${maxBytes} bytes)`,
      )
    }
    const body = await preparePreviewBody(source, pathParam)
    res.writeHead(
      200,
      previewHeaders(previewOutputName(target), body.length, contentType),
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
