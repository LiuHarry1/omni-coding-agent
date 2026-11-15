/**
 * Optional JWT identity layer for the agent backend.
 *
 * Used by the "SSO" deployment mode (deploy/docker-compose.sso.yml): an
 * external auth-service issues HS256 JWTs signed with a shared JWT_SECRET.
 * This module VERIFIES that token (no DB, no network) and derives a FIXED
 * per-user workspace from the email in the token.
 *
 * The whole layer is gated by AUTH_ENABLED:
 *   - AUTH_ENABLED unset/false → `authenticateRequest` returns null and the
 *     server keeps its legacy single-user behavior (client-chosen workspace).
 *   - AUTH_ENABLED=true → every protected request must carry a valid JWT as
 *     `Authorization: Bearer`. A `coding_agent_auth_token` cookie is accepted
 *     only on the few read-only GETs listed in `COOKIE_AUTH_GET_PATHS`, which
 *     the browser reaches by top-level navigation. The workspace is pinned to
 *     /USERS_ROOT/<slug(email)> and the client-supplied `workspace` is
 *     ignored.
 *
 * Env:
 *   AUTH_ENABLED   "true" to turn the gate on.
 *   JWT_SECRET     shared HMAC secret (same value as auth-service). Required.
 *   JWT_ALGORITHM  only HS256 is supported (default HS256).
 *   USERS_ROOT          parent dir for per-user workspaces (default: the
 *                       server's default workspace).
 *   WORKSPACE_SEED_DIR  template copied into a user's workspace on first
 *                       login (default `/opt/workspace-seed`). Set to empty
 *                       string to disable. Baked by tenant images — see
 *                       `deploy/workspace-seed/`.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage } from 'http'
import { getDefaultWorkspace } from '../../utils/workspace/workspace.js'
import { seedUserWorkspaceIfNeeded } from '../../utils/workspace/seed.js'
import { isAuthEnabled } from '../../utils/env.js'

export interface AuthIdentity {
  email: string
  username: string
  role: string
}

/** Carries an HTTP status so the router can answer 401 vs 500 correctly. */
export class AuthError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 401) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

/** Request augmented by `authenticateRequest` once a token is verified. */
export interface AuthedRequest extends IncomingMessage {
  user?: AuthIdentity
  userWorkspace?: string
}

/** Same-origin cookie the SPA mirrors from localStorage so GET navigation can auth. */
export const AUTH_COOKIE_NAME = 'coding_agent_auth_token'

/**
 * The only paths where the cookie may stand in for the bearer header: a
 * top-level navigation (chart preview opened in a new tab) cannot attach one.
 * Keeping the list to read-only GETs means the cookie carries no ambient
 * authority over the mutating API, so a same-site request forged elsewhere
 * cannot act as the user. Matched after `stripMountPath`, so `/code/…` works.
 */
const COOKIE_AUTH_GET_PATHS = ['/workspace/preview']

/** JWT role that may list/view any user's sessions (SSO mode). */
const SUPER_ROLE = 'super'

/** True when the token carries the privileged `super` role. */
export function isSuperRole(role: string | undefined): boolean {
  if (!role) return false
  return role.trim().toLowerCase() === SUPER_ROLE
}

export function isSuperUser(user?: Pick<AuthIdentity, 'role'> | null): boolean {
  return isSuperRole(user?.role)
}

function getSecret(): string {
  const s = process.env.JWT_SECRET
  if (!s || !s.trim()) {
    throw new AuthError('Server auth misconfigured: JWT_SECRET is empty', 500)
  }
  return s
}

function b64urlToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  return Buffer.from(
    input.replace(/-/g, '+').replace(/_/g, '/') + pad,
    'base64',
  )
}

/**
 * Verify an HS256 JWT and return the identity. Throws AuthError on any
 * problem (bad signature, expiry, malformed). Mirrors the claims emitted by
 * auth-service: `sub` (email), `username`, `role`.
 */
export function verifyJwt(token: string): AuthIdentity {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError('Malformed token')
  const [headerB64, payloadB64, sigB64] = parts

  let header: { alg?: string }
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'))
  } catch {
    throw new AuthError('Malformed token header')
  }
  const expectedAlg = (process.env.JWT_ALGORITHM || 'HS256').toUpperCase()
  if (expectedAlg !== 'HS256') {
    throw new AuthError(
      `Unsupported JWT_ALGORITHM ${expectedAlg} (only HS256)`,
      500,
    )
  }
  if ((header.alg || '').toUpperCase() !== 'HS256') {
    throw new AuthError(`Unexpected token alg ${header.alg}`)
  }

  const expectedSig = crypto
    .createHmac('sha256', getSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  const actualSig = b64urlToBuffer(sigB64)
  if (
    expectedSig.length !== actualSig.length ||
    !crypto.timingSafeEqual(expectedSig, actualSig)
  ) {
    throw new AuthError('Bad token signature')
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'))
  } catch {
    throw new AuthError('Malformed token payload')
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new AuthError('Token expired')
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new AuthError('Token not yet valid')
  }

  const email = (payload.sub as string) || (payload.email as string)
  if (!email || typeof email !== 'string') {
    throw new AuthError('Token missing subject (email)')
  }
  return {
    email,
    username: typeof payload.username === 'string' ? payload.username : email,
    role: typeof payload.role === 'string' ? payload.role : 'user',
  }
}

/** Map an email to a filesystem-safe directory name. */
export function slugifyEmail(email: string): string {
  return (
    email
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'user'
  )
}

export function getUsersRoot(): string {
  const r = process.env.USERS_ROOT
  return r && r.trim() ? path.resolve(r) : getDefaultWorkspace()
}

/**
 * Resolve (and create on first use) the fixed workspace for a user. The
 * mapping is deterministic (email → slug → dir) so no database is needed.
 */
export function resolveUserWorkspace(email: string): string {
  const dir = path.join(getUsersRoot(), slugifyEmail(email))
  fs.mkdirSync(dir, { recursive: true })
  const resolved = path.resolve(dir)
  seedUserWorkspaceIfNeeded(resolved)
  return resolved
}

function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers['authorization']
  if (!h) return null
  const raw = Array.isArray(h) ? h[0] : h
  const parts = raw.split(/\s+/)
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null
  return parts[1].trim() || null
}

function extractCookieToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie
  if (!header) return null
  const raw = Array.isArray(header) ? header.join('; ') : header
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    if (part.slice(0, idx).trim() !== AUTH_COOKIE_NAME) continue
    const value = part.slice(idx + 1).trim()
    // Keep scanning: the same name can appear twice under different paths.
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

function allowsCookieAuth(req: IncomingMessage): boolean {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false
  const url = req.url ?? '/'
  const queryAt = url.indexOf('?')
  return COOKIE_AUTH_GET_PATHS.includes(
    queryAt === -1 ? url : url.slice(0, queryAt),
  )
}

/** Bearer header wins; cookie covers top-level navigations that cannot set it. */
export function extractAccessToken(req: IncomingMessage): string | null {
  return (
    extractBearer(req) ??
    (allowsCookieAuth(req) ? extractCookieToken(req) : null)
  )
}

/**
 * Gate entrypoint. Returns null when auth is disabled (caller keeps legacy
 * behavior). When enabled, verifies the JWT (bearer header, or the auth
 * cookie on a `COOKIE_AUTH_GET_PATHS` navigation), pins the user's workspace,
 * mutates `req` (so downstream handlers can read `req.user` /
 * `req.userWorkspace`), and returns both. Throws AuthError otherwise.
 */
export function authenticateRequest(
  req: AuthedRequest,
): { identity: AuthIdentity; workspace: string } | null {
  if (!isAuthEnabled()) return null
  const token = extractAccessToken(req)
  if (!token) throw new AuthError('Missing bearer token')
  const identity = verifyJwt(token)
  const workspace = resolveUserWorkspace(identity.email)
  req.user = identity
  req.userWorkspace = workspace
  return { identity, workspace }
}
