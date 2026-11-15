/**
 * Daily token quota client (SSO cloud deploy).
 *
 * Checks quota once per new chat request; commits total tokens when the
 * request finishes. Backed by analytics `/v1/quota/*` (MySQL counters).
 *
 * Env:
 *   QUOTA_ENABLED              "true" to enforce (also requires AUTH + ANALYTICS_URL)
 *   ANALYTICS_URL              analytics base URL
 *   ANALYTICS_INGEST_API_KEY   shared secret (X-API-Key)
 */
import { isSuperRole } from './auth/identity.js'
import { isAuthEnabled } from '../utils/env.js'

export interface QuotaStatus {
  user_email: string
  usage_date: string
  used: number
  limit: number
  remaining: number
  exceeded: boolean
  unlimited: boolean
  reset_at: string
}

const ENDPOINT = (process.env.ANALYTICS_URL ?? '').replace(/\/+$/, '')
const API_KEY = process.env.ANALYTICS_INGEST_API_KEY ?? ''

export function isQuotaEnabled(): boolean {
  return (
    String(process.env.QUOTA_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true' &&
    isAuthEnabled() &&
    ENDPOINT.length > 0
  )
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
  }
}

export async function checkQuota(userEmail: string): Promise<QuotaStatus> {
  const url = new URL(`${ENDPOINT}/v1/quota/status`)
  url.searchParams.set('user_email', userEmail)
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`quota status HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as QuotaStatus
}

export async function commitQuota(
  userEmail: string,
  tokens: number,
  eventId: string,
): Promise<void> {
  if (tokens <= 0) return
  const res = await fetch(`${ENDPOINT}/v1/quota/commit`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      user_email: userEmail,
      tokens,
      event_id: eventId,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[quota] commit HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
}

/** Skip quota for unauthenticated local mode and super users. */
export function shouldEnforceQuota(
  userEmail: string | undefined,
  role?: string,
): boolean {
  if (!isQuotaEnabled()) return false
  if (!userEmail) return false
  if (isSuperRole(role)) return false
  return true
}

/** Subscribe to usage events for one chat request; returns unsubscribe. */
export function trackTurnTokens(
  eventBus: { on: (event: string, cb: (data: unknown) => void) => () => void },
  acc: { tokens: number },
): () => void {
  return eventBus.on('usage', data => {
    const e = data as {
      totalTokens?: number
      inputTokens?: number
      outputTokens?: number
    }
    acc.tokens += e.totalTokens ?? (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
  })
}
