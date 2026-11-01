import type { IncomingMessage, ServerResponse } from 'http'

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

export const MAX_BODY_SIZE = 20 * 1024 * 1024

export function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('Body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function sendJSON(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function envEnabled(name: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '')
}

function configuredOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
    return (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    )
  } catch {
    return false
  }
}

function corsOrigin(req?: IncomingMessage): string | null {
  const origin = req?.headers.origin
  if (envEnabled('BAIZE_ALLOW_ANY_ORIGIN')) return '*'
  if (!origin) return null

  const configured = configuredOrigins()
  if (configured.includes(origin)) return origin

  try {
    const requestHost = req?.headers.host
    if (requestHost && new URL(origin).host === requestHost) return origin
  } catch {
    return null
  }

  const authEnabled = envEnabled('AUTH_ENABLED')
  return !authEnabled && configured.length === 0 && isLoopbackOrigin(origin)
    ? origin
    : null
}

export function setCORS(res: ServerResponse, req?: IncomingMessage): void {
  const allowedOrigin = corsOrigin(req)
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    if (allowedOrigin !== '*') {
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
  }
  if (allowedOrigin !== '*') {
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  )
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Last-Event-ID',
  )
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Run-Id, X-Session-Id, X-Permission-Mode, X-Agent-Type',
  )
  // Chrome Private / Local Network Access preflight (split-origin :8090 → :4567).
  const pna = req?.headers['access-control-request-private-network']
  if (pna === 'true' && allowedOrigin) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
}

export function wantsStreamingResponse(
  req: IncomingMessage,
  body: Record<string, unknown>,
): boolean {
  const urlQuery = new URLSearchParams(req.url?.split('?')[1] ?? '')
  const acceptsJSON = (req.headers['accept'] ?? '').includes('application/json')
  return (
    urlQuery.get('stream') !== 'false' && body.stream !== false && !acceptsJSON
  )
}
