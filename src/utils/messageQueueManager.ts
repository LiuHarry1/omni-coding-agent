/**
 * Unified command queue (Claude Code `utils/messageQueueManager.ts`).
 *
 * Everything that wants the agent's attention while it may be busy goes
 * through this one queue: messages the user sends during a turn, and
 * notifications from background tasks. The query loop drains it between
 * tool rounds; whatever is left when a turn ends is picked up by the queue
 * processor (`services/queue/queue-processor.ts`).
 *
 * Priority determines dequeue order: 'now' > 'next' > 'later'. Within the
 * same priority, commands are processed FIFO.
 *
 * Claude Code runs one session per process and keeps one module-level
 * queue; this server hosts many sessions, so every operation takes the
 * session id first.
 */

export type QueuePriority = 'now' | 'next' | 'later'

/** 'prompt' for user messages, 'task-notification' for system events. */
export type QueuedCommandMode = 'prompt' | 'task-notification'

/** Who a queued command came from, when it is not the user typing. */
export type MessageOrigin =
  { kind: 'human' } | { kind: 'task-notification' } | { kind: 'coordinator' }

export type QueuedCommand = {
  value: string
  mode: QueuedCommandMode
  /** Defaults: `enqueue` → 'next', `enqueuePendingNotification` → 'later'. */
  priority?: QueuePriority
  uuid?: string
  /**
   * The subagent this command is addressed to. Undefined means the main
   * thread; each drain takes only what is addressed to it.
   */
  agentId?: string
  /** System-generated rather than typed by the user. */
  isMeta?: boolean
  origin?: MessageOrigin
}

type QueueListener = (sessionId: string) => void

let betweenTurnProcessing = false

/**
 * Whether this host answers queued task notifications in turns of their own
 * once a session is idle (the HTTP server's queue processor). Hosts that do
 * not -- the stdio CLI, ACP -- hand them over inside the user's turns
 * instead: with the opening message and after every tool round.
 */
export function setBetweenTurnProcessing(enabled: boolean): void {
  betweenTurnProcessing = enabled
}

export function hasBetweenTurnProcessing(): boolean {
  return betweenTurnProcessing
}

const queues = new Map<string, QueuedCommand[]>()
const listeners = new Set<QueueListener>()

function queueFor(sessionId: string): QueuedCommand[] {
  let queue = queues.get(sessionId)
  if (!queue) {
    queue = []
    queues.set(sessionId, queue)
  }
  return queue
}

function notifySubscribers(sessionId: string): void {
  if (queues.get(sessionId)?.length === 0) queues.delete(sessionId)
  for (const listener of [...listeners]) {
    try {
      listener(sessionId)
    } catch (err) {
      console.warn(
        `[queue] subscriber failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

// ── Subscription ────────────────────────────────

/** Called with the session id after every change to that session's queue. */
export function subscribeToCommandQueue(listener: QueueListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ── Read operations ─────────────────────────────

/** A copy of the session's queue, in insertion order. */
export function getCommandQueue(sessionId: string): QueuedCommand[] {
  return [...(queues.get(sessionId) ?? [])]
}

export function getCommandQueueLength(sessionId: string): number {
  return queues.get(sessionId)?.length ?? 0
}

export function hasCommandsInQueue(sessionId: string): boolean {
  return getCommandQueueLength(sessionId) > 0
}

/** Sessions that currently have something queued. */
export function getSessionsWithQueuedCommands(): string[] {
  return [...queues.entries()]
    .filter(([, queue]) => queue.length > 0)
    .map(([sessionId]) => sessionId)
}

/**
 * Notify subscribers without changing anything. Use after async processing
 * completes so remaining commands are picked up.
 */
export function recheckCommandQueue(sessionId: string): void {
  if (hasCommandsInQueue(sessionId)) notifySubscribers(sessionId)
}

// ── Write operations ────────────────────────────

/**
 * Add a command to the queue.
 * Used for user-initiated commands. Defaults priority to 'next' (processed
 * before task notifications).
 */
export function enqueue(sessionId: string, command: QueuedCommand): void {
  queueFor(sessionId).push({
    ...command,
    priority: command.priority ?? 'next',
  })
  notifySubscribers(sessionId)
}

/**
 * Add a task notification to the queue.
 * Convenience wrapper that defaults priority to 'later' so user input is
 * never starved by system messages.
 */
export function enqueuePendingNotification(
  sessionId: string,
  command: QueuedCommand,
): void {
  queueFor(sessionId).push({
    ...command,
    priority: command.priority ?? 'later',
  })
  notifySubscribers(sessionId)
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/** Index of the first command with the highest priority that passes `filter`. */
function bestIndex(
  queue: QueuedCommand[],
  filter?: (cmd: QueuedCommand) => boolean,
): number {
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < queue.length; i++) {
    const cmd = queue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  return bestIdx
}

/**
 * Remove and return the highest-priority command, or undefined if empty.
 * Within the same priority level, commands are dequeued FIFO.
 *
 * An optional `filter` narrows the candidates: only commands for which the
 * predicate returns `true` are considered. Non-matching commands stay in
 * the queue untouched.
 */
export function dequeue(
  sessionId: string,
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const queue = queues.get(sessionId)
  if (!queue || queue.length === 0) return undefined
  const idx = bestIndex(queue, filter)
  if (idx === -1) return undefined
  const [dequeued] = queue.splice(idx, 1)
  notifySubscribers(sessionId)
  return dequeued
}

/** Remove and return all commands from the queue. */
export function dequeueAll(sessionId: string): QueuedCommand[] {
  const queue = queues.get(sessionId)
  if (!queue || queue.length === 0) return []
  const commands = [...queue]
  queue.length = 0
  notifySubscribers(sessionId)
  return commands
}

/**
 * Return the highest-priority command without removing it, or undefined if
 * empty. Accepts an optional `filter` — only commands passing the predicate
 * are considered.
 */
export function peek(
  sessionId: string,
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const queue = queues.get(sessionId)
  if (!queue || queue.length === 0) return undefined
  const idx = bestIndex(queue, filter)
  return idx === -1 ? undefined : queue[idx]
}

/**
 * Remove and return all commands matching a predicate, in queue order.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  sessionId: string,
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const queue = queues.get(sessionId)
  if (!queue) return []
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of queue) {
    if (predicate(cmd)) matched.push(cmd)
    else remaining.push(cmd)
  }
  if (matched.length === 0) return []
  queue.length = 0
  queue.push(...remaining)
  notifySubscribers(sessionId)
  return matched
}

/**
 * Remove specific commands from the queue by reference identity.
 * Callers must pass the same object references that are in the queue
 * (e.g. from getCommandsByMaxPriority).
 */
export function remove(
  sessionId: string,
  commandsToRemove: QueuedCommand[],
): void {
  const queue = queues.get(sessionId)
  if (!queue || commandsToRemove.length === 0) return
  const before = queue.length
  for (let i = queue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(queue[i]!)) queue.splice(i, 1)
  }
  if (queue.length !== before) notifySubscribers(sessionId)
}

/** Remove commands matching a predicate. Returns the removed commands. */
export function removeByFilter(
  sessionId: string,
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const queue = queues.get(sessionId)
  if (!queue) return []
  const removed: QueuedCommand[] = []
  for (let i = queue.length - 1; i >= 0; i--) {
    if (predicate(queue[i]!)) removed.unshift(queue.splice(i, 1)[0]!)
  }
  if (removed.length > 0) notifySubscribers(sessionId)
  return removed
}

/** Clear all commands for a session. */
export function clearCommandQueue(sessionId: string): void {
  const queue = queues.get(sessionId)
  if (!queue || queue.length === 0) return
  queue.length = 0
  notifySubscribers(sessionId)
}

/** Drop every queue and subscriber. Test cleanup. */
export function resetCommandQueue(): void {
  queues.clear()
  listeners.clear()
  betweenTurnProcessing = false
}

/**
 * Commands at or above a given priority level, without removing them.
 * Used for mid-turn draining: after a tool round the loop takes 'next' and
 * above, so task notifications ('later') wait for the turn to end.
 */
export function getCommandsByMaxPriority(
  sessionId: string,
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return (queues.get(sessionId) ?? []).filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/** A command whose text starts with '/' runs as its own turn, never mid-turn. */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return cmd.value.trim().startsWith('/')
}

/**
 * What a query loop may take between tool rounds. The main thread takes
 * what is addressed to nobody; a subagent takes only what is addressed to
 * it. User prompts go to the main thread only.
 */
export function getQueuedCommandsForLoop(
  sessionId: string,
  agentId: string | undefined,
  maxPriority: QueuePriority = 'next',
): QueuedCommand[] {
  return getCommandsByMaxPriority(sessionId, maxPriority).filter(cmd => {
    if (isSlashCommand(cmd)) return false
    if (agentId === undefined) return cmd.agentId === undefined
    return cmd.agentId === agentId
  })
}
