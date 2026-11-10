import { randomUUID } from 'crypto'
import { getRunAgent } from '../../agent-lazy.js'
import { EventBus } from '../../core/event-bus.js'
import { scheduledTurnMessage } from '../../core/protocol-messages.js'
import { runChatTurn } from '../../turn/run-chat-turn.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { createSessionLiveTransport } from '../session-live-hub.js'
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from '../../server/quota.js'
import { attachUsageTelemetry, flushUsage } from '../../server/telemetry.js'
import { endTurn, tryBeginTurn } from '../../session/store.js'
import { formatScheduledPrompt } from './scheduled-prompt.js'
import { resolveScheduledTaskContext } from './settings.js'
import { getCloudWorkspaceManager } from '../cloud-workspaces/index.js'
import { parseCloudEnvironmentId } from '../../execution/providers/cloud/cloud-provider.js'
import type { Session } from '../../core/types.js'
import type { CloudWorkspaceManager } from '../cloud-workspaces/manager.js'
import {
  computeNextRunAtMs,
  isRecurringTaskAged,
  removeCronTasks,
  updateCronTask,
} from './store.js'
import {
  MAX_TIMER_DELAY_MS,
  type FireResult,
  type ScheduledTask,
} from './types.js'

const ERROR_RETRY_BASE_MS = 30_000
const ERROR_RETRY_MAX_MS = 15 * 60_000

export function isScheduledWorkspaceAvailable(
  session: Pick<Session, 'workspace'>,
  manager: CloudWorkspaceManager | null = getCloudWorkspaceManager(),
): boolean {
  const workspaceId = parseCloudEnvironmentId(session.workspace?.environmentId)
  if (!workspaceId) return true
  return manager?.refresh(workspaceId)?.status === 'ready'
}

export async function fireScheduledTask(
  task: ScheduledTask,
  nowMs = Date.now(),
): Promise<FireResult> {
  let context
  try {
    context = resolveScheduledTaskContext(task)
  } catch (error) {
    console.warn(
      `[cron] settings check failed for ${task.id}: ${
        error instanceof Error ? error.message : error
      }`,
    )
    return 'disabled'
  }
  if (!context) {
    removeCronTasks([task.id])
    return 'missing'
  }
  if (!context.enabled) return 'disabled'
  const { agentHome, session, cwd } = context

  if (!tryBeginTurn(session.id, agentHome)) return 'busy'

  if (!isScheduledWorkspaceAvailable(session)) {
    endTurn(session.id)
    removeCronTasks([task.id])
    return 'missing'
  }

  const eventBus = new EventBus()
  const quotaUser = session.ownerEmail
  const quotaEventId = `${session.id}:cron:${randomUUID()}`
  const turnUsage = { tokens: 0 }
  const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage)
  const unsubTelemetry = attachUsageTelemetry(eventBus, {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  })

  const finishQuota = async (): Promise<void> => {
    unsubTurnTokens()
    if (shouldEnforceQuota(quotaUser)) {
      try {
        await commitQuota(quotaUser!, turnUsage.tokens, quotaEventId)
      } catch (err) {
        console.warn(
          `[quota] cron commit failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
  }

  try {
    if (shouldEnforceQuota(quotaUser)) {
      try {
        const q = await checkQuota(quotaUser!)
        if (q.exceeded) {
          updateCronTask(task.id, {
            nextRunAtMs: nowMs + MAX_TIMER_DELAY_MS,
          })
          return 'quota'
        }
      } catch (err) {
        console.warn(
          `[quota] cron status check failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    const runAgent = await getRunAgent()
    const transport = createSessionLiveTransport(session.id)
    const prompt = formatScheduledPrompt(task, new Date(nowMs))
    transport.emit(scheduledTurnMessage(prompt, { session_id: session.id }))
    await runWithRequestScope({ agentHome, cwd }, () =>
      runChatTurn({
        message: prompt,
        session,
        cwd,
        runAgent,
        transport,
        emitHandshake: false,
        isMeta: true,
        eventBus,
      }),
    )
  } catch (err) {
    console.warn(
      `[cron] fire ${task.id} failed: ${err instanceof Error ? err.message : err}`,
    )
    const failureCount = (task.failureCount ?? 0) + 1
    const delay = Math.min(
      ERROR_RETRY_BASE_MS * 2 ** Math.min(failureCount - 1, 10),
      ERROR_RETRY_MAX_MS,
    )
    updateCronTask(task.id, {
      failureCount,
      nextRunAtMs: nowMs + delay,
    })
    console.warn(
      `[cron] task ${task.id} retry=${failureCount} backoffMs=${delay}`,
    )
    return 'error'
  } finally {
    endTurn(session.id)
    unsubTelemetry()
    await finishQuota()
    void flushUsage()
  }

  const aged = isRecurringTaskAged(task, nowMs)
  if (task.recurring && !aged) {
    const next = computeNextRunAtMs(task, nowMs)
    updateCronTask(task.id, {
      lastFiredAt: nowMs,
      failureCount: 0,
      nextRunAtMs: next ?? Number.POSITIVE_INFINITY,
    })
  } else {
    removeCronTasks([task.id])
  }
  return 'fired'
}
