import { describe, expect, it } from 'vitest'
import { expandAttachmentMessagesForAPI } from '../../utils/messages.js'
import { hookResultMessages, hookStoppedMessage } from './messages.js'
import type { AggregatedHookResult } from './types.js'

const result = (
  overrides: Partial<AggregatedHookResult>,
): AggregatedHookResult => ({
  hookName: 'PostToolUse:Edit',
  blockingErrors: [],
  additionalContexts: [],
  outputs: [],
  preventContinuation: false,
  systemMessages: [],
  ...overrides,
})

/** What the model reads for a hook result. */
const rendered = (
  hookResult: AggregatedHookResult,
  options?: Parameters<typeof hookResultMessages>[1],
): string[] =>
  expandAttachmentMessagesForAPI(hookResultMessages(hookResult, options)).map(
    message => JSON.stringify((message as { content: unknown }).content),
  )

describe('hook results in the transcript', () => {
  it('adds nothing for a hook that had nothing to say', () => {
    expect(hookResultMessages(result({}))).toEqual([])
  })

  it('tells the model which command blocked and why', () => {
    const [text] = rendered(
      result({
        blockingErrors: [
          { blockingError: '[lint]: 2 errors in a.ts', command: 'lint' },
        ],
      }),
      { blockingErrors: true },
    )

    expect(text).toContain(
      'PostToolUse:Edit hook blocking error from command: \\"lint\\": [lint]: 2 errors in a.ts',
    )
    expect(text).toContain('<system-reminder>')
  })

  it('leaves blocking errors out when the caller reports them itself', () => {
    expect(
      hookResultMessages(
        result({ blockingErrors: [{ blockingError: 'no', command: 'guard' }] }),
      ),
    ).toEqual([])
  })

  it('passes on the context hooks supplied, joined in order', () => {
    const [text] = rendered(
      result({ additionalContexts: ['Use pnpm.', 'Node 22 only.'] }),
    )

    expect(text).toContain(
      'PostToolUse:Edit hook additional context: Use pnpm.\\nNode 22 only.',
    )
  })

  it('passes on plain output only when asked to', () => {
    const submitted = result({
      hookName: 'UserPromptSubmit',
      outputs: ['On branch main'],
    })

    expect(hookResultMessages(submitted)).toEqual([])
    expect(rendered(submitted, { outputs: true })[0]).toContain(
      'UserPromptSubmit hook success: On branch main',
    )
  })

  it('records that a hook stopped the turn, with its reason', () => {
    const [text] = rendered(
      result({ preventContinuation: true, stopReason: 'Budget used up' }),
    )

    expect(text).toContain(
      'PostToolUse:Edit hook stopped continuation: Budget used up',
    )
  })

  it('has a default reason for a hook that gave none', () => {
    expect(hookStoppedMessage(result({ preventContinuation: true }))).toBe(
      'Execution stopped by hook',
    )
  })
})
