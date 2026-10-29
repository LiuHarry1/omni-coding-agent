import { describe, expect, it } from 'vitest'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { subagentRowSubtitle } = await import('./SubagentCard.jsx')

describe('subagentRowSubtitle', () => {
  it('suppresses a live task that duplicates the headline', () => {
    expect(
      subagentRowSubtitle(
        { status: 'running', liveTask: 'Analyze exports' },
        [],
        'Analyze exports',
      ),
    ).toBe('Starting…')
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
})
