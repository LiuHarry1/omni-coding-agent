import { describe, expect, it } from 'vitest'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { isBackgroundLaunch, subagentRowSubtitle } =
  await import('./SubagentCard.jsx')

describe('a subagent sent to the background', () => {
  const launched = {
    status: 'done',
    result:
      'Async agent launched successfully.\nagentId: a1b2c3d4e (internal ID - do not mention to user.)',
  }

  it('says so instead of summarising steps it has not taken yet', () => {
    expect(isBackgroundLaunch(launched)).toBe(true)
    expect(subagentRowSubtitle(launched, [], 'Audit the routes')).toBe(
      'Started in the background',
    )
  })

  it('is not mistaken for a foreground report or a running call', () => {
    expect(
      isBackgroundLaunch({ status: 'done', result: 'Found 3 routes.' }),
    ).toBe(false)
    expect(isBackgroundLaunch({ status: 'running' })).toBe(false)
  })
})

describe('subagentRowSubtitle', () => {
  it('suppresses a live task that duplicates the headline', () => {
    expect(
      subagentRowSubtitle(
        { status: 'running', liveTask: 'Analyze exports' },
        [],
        'Analyze exports',
      ),
    ).toBe('Planning next moves')
  })

  it('keeps distinct live task text', () => {
    expect(
      subagentRowSubtitle(
        { status: 'running', liveTask: 'Comparing callers' },
        [],
        'Analyze exports',
      ),
    ).toBe('Comparing callers')
  })

  it('prefers a running nested tool and stopping state', () => {
    const nested = [
      {
        type: 'tool_call',
        toolCallId: 'read-1',
        name: 'Read',
        args: { file_path: 'a.ts' },
        status: 'running',
      },
    ]
    expect(
      subagentRowSubtitle(
        { status: 'running', liveTask: 'Analyze exports' },
        nested,
        'Analyze exports',
      ),
    ).not.toBe('Analyze exports')
    expect(
      subagentRowSubtitle({ stopping: true }, nested, 'Analyze exports'),
    ).toBe('Stopping…')
  })

  it('plans between nested steps instead of claiming a final report', () => {
    const settled = [
      { type: 'tool_call', toolCallId: 'grep-1', name: 'Grep', status: 'done' },
    ]
    expect(
      subagentRowSubtitle({ status: 'running' }, settled, 'Find broker'),
    ).toBe('Planning next moves')
  })

  it('says how the call ended once it is done', () => {
    const settled = [
      { type: 'tool_call', toolCallId: 'grep-1', name: 'Grep', status: 'done' },
    ]
    // Not a count of its steps: that is shown where the steps are.
    expect(
      subagentRowSubtitle(
        { status: 'done', result: 'Found the broker.' },
        settled,
        'Find broker',
      ),
    ).toBe('Completed')
    expect(
      subagentRowSubtitle(
        { status: 'done', result: 'Error: Subagent stopped by user.' },
        settled,
        'Find broker',
      ),
    ).toBe('Stopped')
  })
})
