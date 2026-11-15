/**
 * Preconnect to the configured model endpoints.
 *
 * The TCP+TLS handshake is ~100-200ms that otherwise happens inside the first
 * completion request, i.e. squarely on the critical path of the user's first
 * message. Firing a HEAD during boot overlaps it with the rest of startup and
 * the "user is typing" window; Node's global agent pool keeps the socket warm
 * for the real request.
 *
 * Skipped when a proxy/mTLS transport is configured: the SDK then uses its own
 * dispatcher, which would not reuse the pool we warmed.
 */
import type { ModelProfiles } from '../services/llm/model-registry.js'

let fired = false

function hasCustomTransport(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.NODE_EXTRA_CA_CERTS,
  )
}

/**
 * Fire-and-forget warm of every distinct model origin. Safe to call more than
 * once; only the first call does anything.
 */
export function preconnectModelApis(profiles: ModelProfiles): void {
  if (fired) return
  fired = true

  if (hasCustomTransport()) return

  const origins = new Set<string>()
  for (const profile of Object.values(profiles)) {
    if (!profile?.baseURL) continue
    try {
      origins.add(new URL(profile.baseURL).origin)
    } catch {
      /* unparseable baseURL — the real request will surface it */
    }
  }

  for (const origin of origins) {
    void fetch(origin, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }
}
