/**
 * Accounting for model usage outside a turn: a background agent keeps
 * calling the model after the turn that launched it has ended, when the
 * turn's own telemetry and quota subscriptions are gone.
 */
import { randomUUID } from 'crypto'
import type { IEventBus, Session } from '../core/types.js'
import { commitQuota, shouldEnforceQuota, trackTurnTokens } from './quota.js'
import { attachUsageTelemetry, flushUsage } from './telemetry.js'

/** Subscribe to `eventBus`; the returned function settles the account. */
export function accountBackgroundUsage(
  eventBus: IEventBus,
  session: Pick<Session, 'id' | 'ownerEmail'>,
): () => Promise<void> {
  const usage = { tokens: 0 }
  const quotaUser = session.ownerEmail
  const quotaEventId = `${session.id}:background:${randomUUID()}`
  const unsubTokens = trackTurnTokens(eventBus, usage)
  const unsubTelemetry = attachUsageTelemetry(eventBus, {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  })

  return async () => {
    unsubTelemetry()
    unsubTokens()
    if (shouldEnforceQuota(quotaUser)) {
      try {
        await commitQuota(quotaUser!, usage.tokens, quotaEventId)
      } catch (err) {
        console.warn(
          `[quota] background commit failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
    void flushUsage()
  }
}
