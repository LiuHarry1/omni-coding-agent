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

/**
 * Comma-separated origin allowlist from `ALLOWED_ORIGINS`. When unset we
 * fall back to `*` (the previous behavior — fine for same-origin and local
 * dev). Once the frontend is deployed on a different origin, set e.g.
 * `ALLOWED_ORIGINS=https://app.example.com` so the browser allows the
 * cross-origin (and credentialed) requests only from known frontends.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

export function setCORS(res: ServerResponse, req?: IncomingMessage): void {
  if (allowedOrigins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else {
    const origin = req?.headers.origin
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    // A specific allowlist varies the response by Origin, so caches must
    // key on it; without this a cached `*`-less response could leak.
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
  if (pna === 'true') {
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
