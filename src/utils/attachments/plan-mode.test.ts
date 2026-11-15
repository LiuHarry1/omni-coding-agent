import { describe, expect, it } from 'vitest'
import type { ExternalMode } from '../../core/permission-mode.js'
import type { Message, ToolUseContext } from '../../core/types.js'
import { createAttachmentMessage } from '../attachments.js'
import { expandAttachmentMessagesForAPI } from '../messages.js'
import {
  getAskModeAttachments,
  getAskModeExitAttachment,
  getPlanModeAttachments,
} from './plan-mode.js'
import type { Attachment } from './types.js'

function context(mode: ExternalMode): ToolUseContext {
  return {
    cwd: '/repo',
    session: { permissionMode: { mode, planSlug: 'test-plan' } },
  } as unknown as ToolUseContext
}

const human = (text: string): Message => ({ role: 'user', content: text })
const attached = (attachment: Attachment): Message =>
  createAttachmentMessage(attachment)

describe('plan mode reminder', () => {
  it('carries the whole workflow the first time', () => {
    const [reminder] = getPlanModeAttachments(
      [human('plan it')],
      context('plan'),
    )
    expect(reminder).toMatchObject({ type: 'plan_mode', reminderType: 'full' })

    const [text] = expandAttachmentMessagesForAPI([attached(reminder!)])
    const content = JSON.stringify(text)
    expect(content).toContain('Phase 1: Initial Understanding')
    expect(content).toContain('Phase 5: Call ExitPlanMode')
    expect(content).toContain('test-plan.md')
  })

  it('is not repeated within a few turns', () => {
    const ctx = context('plan')
    const [reminder] = getPlanModeAttachments([human('a')], ctx)
    const messages = [human('a'), attached(reminder!), human('b')]
    expect(getPlanModeAttachments(messages, ctx)).toEqual([])
  })

  it('comes back when plan mode is entered again soon after leaving it', () => {
    const ctx = context('plan')
    const [reminder] = getPlanModeAttachments([human('a')], ctx)
    const messages = [
      human('a'),
      attached(reminder!),
      attached({
        type: 'plan_mode_exit',
        planFilePath: '/plans/test-plan.md',
        planExists: false,
      }),
      human('b'),
    ]
    expect(getPlanModeAttachments(messages, ctx)).toMatchObject([
      { type: 'plan_mode' },
    ])
  })
})

describe('ask mode reminder', () => {
  it('is attached while ask mode is active, then not repeated', () => {
    const ctx = context('ask')
    expect(getAskModeAttachments([human('why?')], ctx)).toEqual([
      { type: 'ask_mode' },
    ])
    const messages = [
      human('why?'),
      attached({ type: 'ask_mode' }),
      human('and?'),
    ]
    expect(getAskModeAttachments(messages, ctx)).toEqual([])
    expect(getAskModeAttachments(messages, context('agent'))).toEqual([])
  })

  it('is followed by one exit notice once the mode changes', () => {
    const messages = [human('why?'), attached({ type: 'ask_mode' })]
    expect(getAskModeExitAttachment(messages, context('ask'))).toEqual([])
    expect(getAskModeExitAttachment(messages, context('agent'))).toEqual([
      { type: 'ask_mode_exit' },
    ])

    const afterExit = [...messages, attached({ type: 'ask_mode_exit' })]
    expect(getAskModeExitAttachment(afterExit, context('agent'))).toEqual([])
  })

  it('tells the model which tools it may use', () => {
    const [text] = expandAttachmentMessagesForAPI([
      attached({ type: 'ask_mode' }),
    ])
    expect(JSON.stringify(text)).toContain('Ask mode is active')
  })
})
