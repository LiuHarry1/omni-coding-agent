import { describe, expect, it } from 'vitest'
import { expandAttachmentMessagesForAPI } from '../messages.js'
import type { Message } from '../../core/types.js'
import type { QueuedCommandAttachment } from './types.js'
import {
  getQueuedCommandAttachments,
  isQueuedCommandFromUser,
  wrapCommandText,
} from './queued-commands.js'

const asMessage = (attachment: QueuedCommandAttachment): Message => ({
  type: 'attachment',
  uuid: 'queued-1',
  timestamp: '2026-11-14T00:00:00.000Z',
  isMeta: true,
  attachment,
})

const textForModel = (attachment: QueuedCommandAttachment): string => {
  const [message] = expandAttachmentMessagesForAPI([asMessage(attachment)])
  return (message as { content: string }).content
}

describe('getQueuedCommandAttachments', () => {
  it('carries the queue metadata over', () => {
    expect(
      getQueuedCommandAttachments([
        {
          value: 'also fix b.ts',
          mode: 'prompt',
          uuid: 'u1',
          priority: 'next',
        },
        {
          value: '<task-notification>x</task-notification>',
          mode: 'task-notification',
          priority: 'next',
        },
        {
          value: 'look at src/ only',
          mode: 'prompt',
          agentId: 'agent-1',
          isMeta: true,
          origin: { kind: 'coordinator' },
        },
      ]),
    ).toEqual([
      {
        type: 'queued_command',
        prompt: 'also fix b.ts',
        source_uuid: 'u1',
        commandMode: 'prompt',
      },
      {
        type: 'queued_command',
        prompt: '<task-notification>x</task-notification>',
        commandMode: 'task-notification',
      },
      {
        type: 'queued_command',
        prompt: 'look at src/ only',
        commandMode: 'prompt',
        origin: { kind: 'coordinator' },
        isMeta: true,
      },
    ])
  })
})

describe('queued_command for the model', () => {
  it('tells the model the user wrote while it was working', () => {
    const text = textForModel({
      type: 'queued_command',
      prompt: 'also fix b.ts',
      commandMode: 'prompt',
    })

    expect(text).toContain('<system-reminder>')
    expect(text).toContain(
      'The user sent a new message while you were working:\nalso fix b.ts',
    )
    expect(text).toContain("you MUST address the user's message above")
  })

  it('introduces a task notification as a finished background task', () => {
    const text = textForModel({
      type: 'queued_command',
      prompt: '<task-notification>x</task-notification>',
      commandMode: 'task-notification',
    })

    expect(text).toContain(
      'A background agent completed a task:\n<task-notification>x</task-notification>',
    )
  })

  it('introduces a message from the main agent as the coordinator’s', () => {
    expect(wrapCommandText('look at src/ only', { kind: 'coordinator' })).toBe(
      'The coordinator sent a message while you were working:\nlook at src/ only\n\nAddress this before completing your current task.',
    )
  })
})

describe('isQueuedCommandFromUser', () => {
  it('is true only for what the user typed', () => {
    expect(isQueuedCommandFromUser({ commandMode: 'prompt' })).toBe(true)
    expect(
      isQueuedCommandFromUser({
        commandMode: 'prompt',
        origin: { kind: 'human' },
      }),
    ).toBe(true)
    expect(isQueuedCommandFromUser({ commandMode: 'task-notification' })).toBe(
      false,
    )
    expect(
      isQueuedCommandFromUser({ commandMode: 'prompt', isMeta: true }),
    ).toBe(false)
    expect(
      isQueuedCommandFromUser({
        commandMode: 'prompt',
        origin: { kind: 'coordinator' },
      }),
    ).toBe(false)
  })
})
