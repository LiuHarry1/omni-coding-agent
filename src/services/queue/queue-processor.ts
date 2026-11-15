/**
 * Between-turn half of the command queue (Claude Code
 * `utils/queueProcessor.ts` + `hooks/useQueueProcessor.ts`).
 *
 * The query loop drains the queue between tool rounds. What is still queued
 * when no turn is running is handled here: notifications from background
 * tasks start a turn of their own, streamed over the session's live channel
 * the way a scheduled task is.
 *
 * Messages the user sent during a turn are the exception. The client that
 * queued them still holds them and sends them as an ordinary turn once the
 * running one is over, so the copies left here are dropped at turn end.
 */
import { randomUUID } from 'crypto'
import { runAgent } from '../../core/agent.js'
import { EventBus } from '../../core/event-bus.js'
import { queuedTurnMessage } from '../../core/protocol-messages.js'
import type { Session } from '../../core/types.js'
import { getDefaultWorkspace } from '../../utils/workspace/workspace.js'
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from '../../server/quota.js'
import { attachUsageTelemetry, flushUsage } from '../../server/telemetry.js'
import { findSessionLocation } from '../../session/session-index.js'
import {
  endTurn,
  getSession,
  isTurnActive,
  onTurnEnd,
  tryBeginTurn,
} from '../../session/store.js'
import { runChatTurn } from '../../turn/run-chat-turn.js'
import {
  clearCommandQueue,
  dequeueAllMatching,
  enqueuePendingNotification,
  getSessionsWithQueuedCommands,
  peek,
  removeByFilter,
  setBetweenTurnProcessing,
  subscribeToCommandQueue,
  type QueuedCommand,
} from '../../utils/messageQueueManager.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import {
  resolveWorkspaceContext,
  type WorkspaceContext,
} from '../cloud-workspaces/turn-scope.js'
import { isScheduledWorkspaceAvailable } from '../cron/fire.js'
import { createSessionLiveTransport } from '../session-live-hub.js'
import {
  notificationSummaries,
  queuedTurnPrompt,
} from './queued-turn-prompt.js'

/**
 * Wait this long after the trigger before starting a turn: notifications
 * that arrive together are answered together, and a client still closing
 * the previous turn's stream has time to do so.
 */
export const QUEUE_PROCESS_DELAY_MS = 500

const isMainThread = (cmd: QueuedCommand): boolean => cmd.agentId === undefined

type ProcessQueueParams = {
  sessionId: string
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

/**
 * Processes commands from the queue.
 *
 * All commands with the same mode as the highest-priority one are drained
 * at once and passed to `executeInput` as one batch. Different modes are
 * never mixed.
 *
 * The caller is responsible for ensuring no turn is currently running and
 * for calling this again after each batch completes until the queue is
 * empty.
 */
export function processQueueIfReady({
  sessionId,
  executeInput,
}: ProcessQueueParams): { processed: boolean } {
  // Skip anything addressed to a subagent, and the user's own messages:
  // the client resends those (see discardUnconsumedPrompts).
  const eligible = (cmd: QueuedCommand) =>
    isMainThread(cmd) && cmd.mode !== 'prompt'

  const next = peek(sessionId, eligible)
  if (!next) return { processed: false }

  const targetMode = next.mode
  const commands = dequeueAllMatching(
    sessionId,
    cmd => eligible(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) return { processed: false }

  void executeInput(commands)
  return { processed: true }
}

/**
 * Drop the user's messages the turn did not get to. Their sender shows them
 * as queued until it sees them consumed, and sends them itself otherwise.
 */
export function discardUnconsumedPrompts(sessionId: string): QueuedCommand[] {
  return removeByFilter(
    sessionId,
    cmd => isMainThread(cmd) && cmd.mode === 'prompt',
  )
}

type SessionTurnContext = {
  agentHome: string
  session: Session
  workspace: WorkspaceContext
}

/** Safe from process-level callbacks, where no request scope exists yet. */
function resolveSessionTurnContext(
  sessionId: string,
): SessionTurnContext | null {
  const location = findSessionLocation(sessionId)
  if (!location) return null
  const agentHome = location.agentHome
  return runWithRequestScope({ agentHome, cwd: getDefaultWorkspace() }, () => {
    const session = getSession(sessionId, { agentHome })
    if (!session) return null
    const workspace = resolveWorkspaceContext(
      session.workspace,
      session.workspace?.cwd ?? getDefaultWorkspace(),
    )
    return { agentHome, session, workspace }
  })
}

type QueuedTurnOutcome = 'ran' | 'quota' | 'unavailable' | 'error'

/** One server-initiated turn for a batch of queued commands. */
async function runQueuedTurn(
  context: SessionTurnContext,
  commands: QueuedCommand[],
): Promise<QueuedTurnOutcome> {
  const { agentHome, session, workspace } = context
  if (!isScheduledWorkspaceAvailable(session)) return 'unavailable'

  const eventBus = new EventBus()
  const quotaUser = session.ownerEmail
  const quotaEventId = `${session.id}:queue:${randomUUID()}`
  const turnUsage = { tokens: 0 }
  const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage)
  const unsubTelemetry = attachUsageTelemetry(eventBus, {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  })

  try {
    if (shouldEnforceQuota(quotaUser)) {
      try {
        if ((await checkQuota(quotaUser!)).exceeded) return 'quota'
      } catch (err) {
        console.warn(
          `[quota] queue status check failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    const transport = createSessionLiveTransport(session.id)
    transport.emit(
      queuedTurnMessage(commands[0]!.mode, notificationSummaries(commands), {
        session_id: session.id,
      }),
    )
    await runWithRequestScope({ agentHome, cwd: workspace.cwd }, () =>
      runChatTurn({
        message: queuedTurnPrompt(commands),
        session,
        workspace,
        runAgent,
        transport,
        emitHandshake: false,
        isMeta: true,
        eventBus,
      }),
    )
    return 'ran'
  } catch (err) {
    console.warn(
      `[queue] turn for session ${session.id.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`,
    )
    return 'error'
  } finally {
    unsubTelemetry()
    unsubTurnTokens()
    if (shouldEnforceQuota(quotaUser)) {
      try {
        await commitQuota(quotaUser!, turnUsage.tokens, quotaEventId)
      } catch (err) {
        console.warn(
          `[quota] queue commit failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
    void flushUsage()
  }
}

export type QueueProcessorDeps = {
  /** Runs one turn for the batch; resolves when the turn is over. */
  runTurn: (
    sessionId: string,
    commands: QueuedCommand[],
  ) => Promise<QueuedTurnOutcome>
  /** False when the session no longer exists. */
  sessionExists: (sessionId: string) => boolean
  tryBeginTurn: (sessionId: string) => boolean
  endTurn: (sessionId: string) => void
  isTurnActive: (sessionId: string) => boolean
  onTurnEnd: (listener: (sessionId: string) => void) => () => void
  delayMs: number
}

function productionDeps(): QueueProcessorDeps {
  const contexts = new Map<string, SessionTurnContext>()
  return {
    sessionExists: sessionId => {
      const context = resolveSessionTurnContext(sessionId)
      if (!context) return false
      contexts.set(sessionId, context)
      return true
    },
    tryBeginTurn: sessionId =>
      tryBeginTurn(sessionId, contexts.get(sessionId)?.agentHome),
    endTurn,
    isTurnActive,
    onTurnEnd,
    runTurn: async (sessionId, commands) => {
      const context = contexts.get(sessionId)
      contexts.delete(sessionId)
      if (!context) return 'unavailable'
      return runQueuedTurn(context, commands)
    },
    delayMs: QUEUE_PROCESS_DELAY_MS,
  }
}

/**
 * Watch every session's queue and start a turn when one is due: something
 * is queued and no turn is running. Returns a function that stops watching.
 */
export function startQueueProcessor(
  overrides: Partial<QueueProcessorDeps> = {},
): () => void {
  const deps = { ...productionDeps(), ...overrides }
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Sessions whose queue waits for a turn somebody else starts: the owner's
   * quota is used up, so retrying on our own would only spin.
   */
  const deferred = new Set<string>()
  /** Sessions whose next turn end is our own deferred attempt finishing. */
  const endingDeferredAttempt = new Set<string>()
  let stopped = false

  const run = async (sessionId: string): Promise<void> => {
    if (stopped || deps.isTurnActive(sessionId)) return
    if (!hasRunnableCommands(sessionId)) return
    if (!deps.sessionExists(sessionId)) {
      clearCommandQueue(sessionId)
      return
    }
    if (!deps.tryBeginTurn(sessionId)) return

    let turn: Promise<QueuedTurnOutcome> | undefined
    let batch: QueuedCommand[] = []
    try {
      processQueueIfReady({
        sessionId,
        executeInput: commands => {
          batch = commands
          turn = deps.runTurn(sessionId, commands)
          return turn.then(
            () => {},
            () => {},
          )
        },
      })
      const outcome = turn ? await turn : undefined
      if (outcome === 'quota') {
        deferred.add(sessionId)
        endingDeferredAttempt.add(sessionId)
        for (const command of batch) {
          enqueuePendingNotification(sessionId, command)
        }
      } else if (outcome === 'unavailable') {
        console.warn(
          `[queue] dropped ${batch.length} queued command(s): the workspace of session ${sessionId.slice(0, 8)} is not available`,
        )
      }
    } catch (err) {
      console.warn(
        `[queue] processing session ${sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`,
      )
    } finally {
      // Fires the turn-end listener below, which looks at the queue again.
      deps.endTurn(sessionId)
    }
  }

  const schedule = (sessionId: string): void => {
    if (stopped || timers.has(sessionId)) return
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      void run(sessionId)
    }, deps.delayMs)
    timer.unref?.()
    timers.set(sessionId, timer)
  }

  const unsubscribeQueue = subscribeToCommandQueue(sessionId => {
    // While a turn runs, its end is the trigger.
    if (deferred.has(sessionId) || deps.isTurnActive(sessionId)) return
    if (hasRunnableCommands(sessionId)) schedule(sessionId)
  })
  const unsubscribeTurnEnd = deps.onTurnEnd(sessionId => {
    discardUnconsumedPrompts(sessionId)
    if (endingDeferredAttempt.delete(sessionId)) return
    deferred.delete(sessionId)
    if (hasRunnableCommands(sessionId)) schedule(sessionId)
  })

  // From here on task notifications wait for the turn to end.
  setBetweenTurnProcessing(true)

  // Anything queued before the processor started.
  for (const sessionId of getSessionsWithQueuedCommands()) schedule(sessionId)

  return () => {
    stopped = true
    setBetweenTurnProcessing(false)
    unsubscribeQueue()
    unsubscribeTurnEnd()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
}

function hasRunnableCommands(sessionId: string): boolean {
  return (
    peek(sessionId, cmd => isMainThread(cmd) && cmd.mode !== 'prompt') !==
    undefined
  )
}
