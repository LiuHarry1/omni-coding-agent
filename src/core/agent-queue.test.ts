import { afterEach, describe, expect, it } from 'vitest'
import { runAgent } from './agent.js'
import { createQueryHarness } from './query-test-harness.js'
import type { AttachmentMessage, Message } from './types.js'
import {
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  resetCommandQueue,
  setBetweenTurnProcessing,
} from '../utils/messageQueueManager.js'

const SESSION = 'agent-queue-session'

const mainThread = () =>
  ({
    sessionId: SESSION,
    messages: [] as Message[],
    toolUseContext: {
      cwd: '/workspace',
      session: {
        id: SESSION,
        todos: [],
        messages: [],
        permissionMode: { mode: 'agent' },
      },
      readFileState: new Map(),
      options: { tools: {} },
    },
  }) as unknown as Parameters<typeof createQueryHarness>[0]

const notification =
  '<task-notification>\n<status>completed</status>\n</task-notification>'

const queuedPrompts = (messages: Message[]) =>
  (messages as AttachmentMessage[])
    .filter(message => message.attachment?.type === 'queued_command')
    .map(message => (message.attachment as { prompt: string }).prompt)

afterEach(() => {
  resetCommandQueue()
})

describe('runAgent and the command queue', () => {
  it('opens the turn with finished background tasks on a host without a queue processor', async () => {
    const h = createQueryHarness(mainThread())
    h.scriptSteps([{ text: 'Done.' }])
    enqueuePendingNotification(SESSION, {
      value: notification,
      mode: 'task-notification',
    })

    await runAgent('continue', h.options)

    const messages = h.options.messages!
    expect(queuedPrompts(messages)).toEqual([notification])
    // Ahead of the user's message, like the other attachments.
    const at = messages.findIndex(
      m => (m as AttachmentMessage).attachment?.type === 'queued_command',
    )
    const user = messages.findIndex(
      m => (m as { role?: string; content?: unknown }).content === 'continue',
    )
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(user)
    expect(getCommandQueue(SESSION)).toEqual([])
  })

  it('leaves them to the queue processor where one runs', async () => {
    setBetweenTurnProcessing(true)
    const h = createQueryHarness(mainThread())
    h.scriptSteps([{ text: 'Done.' }])
    enqueuePendingNotification(SESSION, {
      value: notification,
      mode: 'task-notification',
    })

    await runAgent('continue', h.options)

    expect(queuedPrompts(h.options.messages!)).toEqual([])
    expect(getCommandQueue(SESSION)).toHaveLength(1)
  })

  it('does not take what is addressed to a subagent', async () => {
    const h = createQueryHarness(mainThread())
    h.scriptSteps([{ text: 'Done.' }])
    enqueue(SESSION, { value: 'for agent', mode: 'prompt', agentId: 'a1' })

    await runAgent('continue', h.options)

    expect(queuedPrompts(h.options.messages!)).toEqual([])
    expect(getCommandQueue(SESSION)).toHaveLength(1)
  })
})
