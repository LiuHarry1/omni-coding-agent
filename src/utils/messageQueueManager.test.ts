import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCommandQueue,
  dequeue,
  dequeueAll,
  dequeueAllMatching,
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  getCommandsByMaxPriority,
  getQueuedCommandsForLoop,
  getSessionsWithQueuedCommands,
  hasCommandsInQueue,
  peek,
  recheckCommandQueue,
  remove,
  removeByFilter,
  resetCommandQueue,
  subscribeToCommandQueue,
} from './messageQueueManager.js'

const S = 'session-a'

afterEach(() => {
  resetCommandQueue()
})

describe('messageQueueManager', () => {
  it('defaults user commands to next and notifications to later', () => {
    enqueuePendingNotification(S, { value: 'done', mode: 'task-notification' })
    enqueue(S, { value: 'hello', mode: 'prompt' })

    expect(getCommandQueue(S).map(c => c.priority)).toEqual(['later', 'next'])
  })

  it('dequeues by priority, first in first out within one priority', () => {
    enqueuePendingNotification(S, { value: 'n1', mode: 'task-notification' })
    enqueue(S, { value: 'p1', mode: 'prompt' })
    enqueue(S, { value: 'p2', mode: 'prompt' })
    enqueue(S, { value: 'urgent', mode: 'prompt', priority: 'now' })

    expect(peek(S)?.value).toBe('urgent')
    expect(
      [dequeue(S), dequeue(S), dequeue(S), dequeue(S)].map(c => c?.value),
    ).toEqual(['urgent', 'p1', 'p2', 'n1'])
    expect(dequeue(S)).toBeUndefined()
    expect(hasCommandsInQueue(S)).toBe(false)
  })

  it('leaves commands a filter rejects in the queue', () => {
    enqueue(S, { value: 'for-agent', mode: 'prompt', agentId: 'a1' })
    enqueue(S, { value: 'for-main', mode: 'prompt' })
    const isMainThread = (c: { agentId?: string }) => c.agentId === undefined

    expect(peek(S, isMainThread)?.value).toBe('for-main')
    expect(dequeue(S, isMainThread)?.value).toBe('for-main')
    expect(dequeue(S, isMainThread)).toBeUndefined()
    expect(getCommandQueue(S).map(c => c.value)).toEqual(['for-agent'])
  })

  it('keeps one queue per session', () => {
    enqueue(S, { value: 'a', mode: 'prompt' })
    enqueue('session-b', { value: 'b', mode: 'prompt' })

    expect(getCommandQueue(S).map(c => c.value)).toEqual(['a'])
    expect(getSessionsWithQueuedCommands().sort()).toEqual([
      'session-a',
      'session-b',
    ])
    expect(dequeueAll(S).map(c => c.value)).toEqual(['a'])
    expect(getSessionsWithQueuedCommands()).toEqual(['session-b'])
  })

  it('removes all commands matching a predicate, keeping the rest in order', () => {
    enqueue(S, { value: 'p1', mode: 'prompt' })
    enqueuePendingNotification(S, { value: 'n1', mode: 'task-notification' })
    enqueue(S, { value: 'p2', mode: 'prompt' })

    expect(
      dequeueAllMatching(S, c => c.mode === 'prompt').map(c => c.value),
    ).toEqual(['p1', 'p2'])
    expect(getCommandQueue(S).map(c => c.value)).toEqual(['n1'])
    expect(dequeueAllMatching(S, c => c.mode === 'prompt')).toEqual([])
  })

  it('removes by reference and by filter', () => {
    enqueue(S, { value: 'p1', mode: 'prompt', uuid: 'u1' })
    enqueue(S, { value: 'p2', mode: 'prompt', uuid: 'u2' })
    enqueue(S, { value: 'p3', mode: 'prompt', uuid: 'u3' })

    const [first] = getCommandsByMaxPriority(S, 'next')
    remove(S, [first!])
    expect(getCommandQueue(S).map(c => c.uuid)).toEqual(['u2', 'u3'])

    // An equal-looking copy is not the queued object.
    remove(S, [{ value: 'p2', mode: 'prompt', uuid: 'u2', priority: 'next' }])
    expect(getCommandQueue(S)).toHaveLength(2)

    expect(removeByFilter(S, c => c.uuid === 'u3').map(c => c.value)).toEqual([
      'p3',
    ])
    expect(getCommandQueue(S).map(c => c.uuid)).toEqual(['u2'])
  })

  it('returns commands at or above a priority without removing them', () => {
    enqueuePendingNotification(S, { value: 'n1', mode: 'task-notification' })
    enqueue(S, { value: 'p1', mode: 'prompt' })
    enqueue(S, { value: 'now', mode: 'prompt', priority: 'now' })

    expect(getCommandsByMaxPriority(S, 'now').map(c => c.value)).toEqual([
      'now',
    ])
    expect(getCommandsByMaxPriority(S, 'next').map(c => c.value)).toEqual([
      'p1',
      'now',
    ])
    expect(getCommandsByMaxPriority(S, 'later')).toHaveLength(3)
    expect(getCommandQueue(S)).toHaveLength(3)
  })

  it('gives each loop only what is addressed to it between tool rounds', () => {
    enqueue(S, { value: 'for main', mode: 'prompt' })
    enqueue(S, { value: '/compact', mode: 'prompt' })
    enqueue(S, { value: 'for agent', mode: 'prompt', agentId: 'a1' })
    enqueuePendingNotification(S, { value: 'late', mode: 'task-notification' })
    enqueuePendingNotification(S, {
      value: 'stalled',
      mode: 'task-notification',
      priority: 'next',
    })

    expect(getQueuedCommandsForLoop(S, undefined).map(c => c.value)).toEqual([
      'for main',
      'stalled',
    ])
    expect(getQueuedCommandsForLoop(S, 'a1').map(c => c.value)).toEqual([
      'for agent',
    ])
    expect(getQueuedCommandsForLoop(S, 'a2')).toEqual([])
    expect(
      getQueuedCommandsForLoop(S, undefined, 'later').map(c => c.value),
    ).toEqual(['for main', 'late', 'stalled'])
  })

  it('tells subscribers which session changed', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToCommandQueue(listener)

    enqueue(S, { value: 'p1', mode: 'prompt' })
    dequeue(S)
    dequeue(S)
    expect(listener.mock.calls).toEqual([[S], [S]])

    recheckCommandQueue(S)
    expect(listener).toHaveBeenCalledTimes(2)

    enqueue(S, { value: 'p2', mode: 'prompt' })
    recheckCommandQueue(S)
    clearCommandQueue(S)
    clearCommandQueue(S)
    expect(listener).toHaveBeenCalledTimes(5)

    unsubscribe()
    enqueue(S, { value: 'p3', mode: 'prompt' })
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('survives a subscriber that throws', () => {
    const second = vi.fn()
    subscribeToCommandQueue(() => {
      throw new Error('boom')
    })
    subscribeToCommandQueue(second)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    enqueue(S, { value: 'p1', mode: 'prompt' })

    expect(second).toHaveBeenCalledWith(S)
    expect(getCommandQueue(S)).toHaveLength(1)
    warn.mockRestore()
  })
})
