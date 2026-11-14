import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  hasBetweenTurnProcessing,
  resetCommandQueue,
  type QueuedCommand,
} from '../../utils/messageQueueManager.js'
import {
  discardUnconsumedPrompts,
  processQueueIfReady,
  startQueueProcessor,
  type QueueProcessorDeps,
} from './queue-processor.js'
import {
  isTaskNotificationText,
  notificationSummaries,
  queuedTurnPrompt,
} from './queued-turn-prompt.js'

const S = 'session-a'

const notification = (taskId: string, summary: string): QueuedCommand => ({
  value: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
  mode: 'task-notification',
})

afterEach(() => {
  resetCommandQueue()
})

describe('processQueueIfReady', () => {
  it('takes every queued notification as one batch', () => {
    enqueuePendingNotification(S, notification('b1', 'one'))
    enqueuePendingNotification(S, notification('b2', 'two'))
    const executeInput = vi.fn(async () => {})

    expect(processQueueIfReady({ sessionId: S, executeInput })).toEqual({
      processed: true,
    })

    expect(executeInput).toHaveBeenCalledTimes(1)
    expect(
      (executeInput.mock.calls[0] as unknown as [QueuedCommand[]])[0],
    ).toHaveLength(2)
    expect(getCommandQueue(S)).toEqual([])
  })

  it('leaves the user’s messages and subagent mail alone', () => {
    enqueue(S, { value: 'typed during the turn', mode: 'prompt' })
    enqueuePendingNotification(S, {
      ...notification('b1', 'one'),
      agentId: 'agent-1',
    })
    const executeInput = vi.fn(async () => {})

    expect(processQueueIfReady({ sessionId: S, executeInput })).toEqual({
      processed: false,
    })

    expect(executeInput).not.toHaveBeenCalled()
    expect(getCommandQueue(S)).toHaveLength(2)
  })

  it('does nothing for an empty queue', () => {
    const executeInput = vi.fn(async () => {})
    expect(processQueueIfReady({ sessionId: S, executeInput })).toEqual({
      processed: false,
    })
  })
})

describe('queued turn text', () => {
  it('joins the notifications into one prompt', () => {
    expect(
      queuedTurnPrompt([notification('b1', 'one'), notification('b2', 'two')]),
    ).toBe(
      `${notification('b1', 'one').value}\n\n${notification('b2', 'two').value}`,
    )
  })

  it('reads the summary of each notification for display', () => {
    expect(
      notificationSummaries([
        notification('b1', 'Background command &quot;npm test&quot; completed'),
        notification('a1', 'Agent &quot;a &lt; b &amp; c&quot; completed'),
        { value: 'no summary here', mode: 'task-notification' },
      ]),
    ).toEqual([
      'Background command "npm test" completed',
      'Agent "a < b & c" completed',
      'Background task update',
    ])
  })
})

describe('isTaskNotificationText', () => {
  it('recognises the opening message of a notification turn', () => {
    expect(isTaskNotificationText(notification('b1', 'one').value)).toBe(true)
    expect(isTaskNotificationText('  \n<task-notification>x')).toBe(true)
    expect(isTaskNotificationText('please read <task-notification>')).toBe(
      false,
    )
  })
})

describe('discardUnconsumedPrompts', () => {
  it('drops only the main thread’s user messages', () => {
    enqueue(S, { value: 'typed', mode: 'prompt', uuid: 'u1' })
    enqueue(S, { value: 'to agent', mode: 'prompt', agentId: 'agent-1' })
    enqueuePendingNotification(S, notification('b1', 'one'))

    expect(discardUnconsumedPrompts(S).map(c => c.uuid)).toEqual(['u1'])
    expect(getCommandQueue(S).map(c => c.value)).toEqual([
      'to agent',
      notification('b1', 'one').value,
    ])
  })
})

describe('startQueueProcessor', () => {
  let active: Set<string>
  let turnEndListeners: Array<(sessionId: string) => void>
  let runTurn: ReturnType<typeof vi.fn<QueueProcessorDeps['runTurn']>>
  let stop: (() => void) | undefined

  const deps = (
    overrides: Partial<QueueProcessorDeps> = {},
  ): Partial<QueueProcessorDeps> => ({
    runTurn,
    sessionExists: () => true,
    tryBeginTurn: sessionId => {
      if (active.has(sessionId)) return false
      active.add(sessionId)
      return true
    },
    endTurn: sessionId => {
      if (!active.delete(sessionId)) return
      for (const listener of [...turnEndListeners]) listener(sessionId)
    },
    isTurnActive: sessionId => active.has(sessionId),
    onTurnEnd: listener => {
      turnEndListeners.push(listener)
      return () => {
        turnEndListeners = turnEndListeners.filter(l => l !== listener)
      }
    },
    delayMs: 100,
    ...overrides,
  })

  /** A turn somebody else runs (a chat request). */
  const userTurn = {
    begin: () => active.add(S),
    end: () => {
      active.delete(S)
      for (const listener of [...turnEndListeners]) listener(S)
    },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    active = new Set()
    turnEndListeners = []
    runTurn = vi.fn<QueueProcessorDeps['runTurn']>(async () => 'ran')
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    vi.useRealTimers()
  })

  it('starts one turn for notifications that arrive together while idle', async () => {
    stop = startQueueProcessor(deps())

    enqueuePendingNotification(S, notification('b1', 'one'))
    enqueuePendingNotification(S, notification('b2', 'two'))
    expect(runTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)

    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(runTurn.mock.calls[0]![0]).toBe(S)
    expect(runTurn.mock.calls[0]![1]).toHaveLength(2)
    expect(active.has(S)).toBe(false)
    expect(getCommandQueue(S)).toEqual([])
  })

  it('waits for the running turn to end', async () => {
    stop = startQueueProcessor(deps())
    userTurn.begin()

    enqueuePendingNotification(S, notification('b1', 'one'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(runTurn).not.toHaveBeenCalled()

    userTurn.end()
    await vi.advanceTimersByTimeAsync(100)
    expect(runTurn).toHaveBeenCalledTimes(1)
  })

  it('holds the session while its turn runs and picks up what arrived meanwhile', async () => {
    let finishFirst: (() => void) | undefined
    runTurn.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishFirst = () => resolve('ran')
        }),
    )
    stop = startQueueProcessor(deps())

    enqueuePendingNotification(S, notification('b1', 'one'))
    await vi.advanceTimersByTimeAsync(100)
    expect(active.has(S)).toBe(true)

    enqueuePendingNotification(S, notification('b2', 'two'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(runTurn).toHaveBeenCalledTimes(1)

    finishFirst!()
    await vi.advanceTimersByTimeAsync(100)
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn.mock.calls[1]![1]).toMatchObject([
      { value: notification('b2', 'two').value },
    ])
  })

  it('drops the user’s unconsumed messages when a turn ends and starts nothing for them', async () => {
    stop = startQueueProcessor(deps())
    userTurn.begin()
    enqueue(S, { value: 'typed during the turn', mode: 'prompt' })

    userTurn.end()
    await vi.advanceTimersByTimeAsync(1000)

    expect(getCommandQueue(S)).toEqual([])
    expect(runTurn).not.toHaveBeenCalled()
  })

  it('keeps notifications for the next turn when the quota is used up', async () => {
    runTurn.mockResolvedValueOnce('quota')
    stop = startQueueProcessor(deps())

    enqueuePendingNotification(S, notification('b1', 'one'))
    await vi.advanceTimersByTimeAsync(100)
    expect(runTurn).toHaveBeenCalledTimes(1)

    // Still queued, and not retried on a loop.
    await vi.advanceTimersByTimeAsync(5000)
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(getCommandQueue(S)).toHaveLength(1)

    // Another notification does not start a turn either.
    enqueuePendingNotification(S, notification('b2', 'two'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(runTurn).toHaveBeenCalledTimes(1)

    // After a turn of the user's they are tried again, together.
    userTurn.begin()
    userTurn.end()
    await vi.advanceTimersByTimeAsync(100)
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn.mock.calls[1]![1]).toHaveLength(2)
  })

  it('clears the queue of a session that no longer exists', async () => {
    stop = startQueueProcessor(deps({ sessionExists: () => false }))

    enqueuePendingNotification(S, notification('b1', 'one'))
    await vi.advanceTimersByTimeAsync(100)

    expect(runTurn).not.toHaveBeenCalled()
    expect(getCommandQueue(S)).toEqual([])
  })

  it('releases the session when the turn throws', async () => {
    runTurn.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stop = startQueueProcessor(deps())

    enqueuePendingNotification(S, notification('b1', 'one'))
    await vi.advanceTimersByTimeAsync(100)

    expect(active.has(S)).toBe(false)
    warn.mockRestore()
  })

  it('picks up what was queued before it started and stops when told to', async () => {
    enqueuePendingNotification(S, notification('b1', 'one'))
    expect(hasBetweenTurnProcessing()).toBe(false)
    stop = startQueueProcessor(deps())
    expect(hasBetweenTurnProcessing()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(runTurn).toHaveBeenCalledTimes(1)

    stop()
    expect(hasBetweenTurnProcessing()).toBe(false)
    enqueuePendingNotification(S, notification('b2', 'two'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(runTurn).toHaveBeenCalledTimes(1)
  })
})
