import { describe, expect, it } from 'vitest'
import {
  subagentAgentId,
  subagentCallBubbles,
  subagentConversation,
  subagentDurationLabel,
  subagentOutcome,
  subagentReport,
  subagentStatusLine,
  subagentSummary,
  subagentTimeLabel,
  subagentTurns,
  subagentTypeLabel,
} from './subagent-view.js'

const RESUME =
  '\n\nagentId: a1b2c3d4e (use SendMessage with this id to continue this agent with its full context)'

const read = (id, status = 'done') => ({
  type: 'tool_call',
  toolCallId: id,
  name: 'Read',
  args: { file_path: `${id}.ts` },
  status,
})
const said = (id, content) => ({ type: 'text', id, content })

describe('subagentTypeLabel', () => {
  it('names the built-in agents and title-cases the rest', () => {
    expect(subagentTypeLabel('Explore')).toBe('Explorer')
    expect(subagentTypeLabel('explore')).toBe('Explorer')
    expect(subagentTypeLabel('Plan')).toBe('Plan')
    expect(subagentTypeLabel('general-purpose')).toBe('General Purpose')
    expect(subagentTypeLabel('code-reviewer')).toBe('Code Reviewer')
    expect(subagentTypeLabel('codeReviewer')).toBe('Code Reviewer')
    expect(subagentTypeLabel('db_migrator')).toBe('Db Migrator')
    // Not known: the card shows no type rather than a made-up one.
    expect(subagentTypeLabel(undefined)).toBe('')
    expect(subagentTypeLabel('  ')).toBe('')
  })
})

describe('subagentOutcome', () => {
  it('is running until the call is done', () => {
    expect(subagentOutcome({ status: 'running' })).toBe('running')
    // Even when a stale result says otherwise.
    expect(
      subagentOutcome({
        status: 'running',
        toolUseResult: { status: 'completed' },
      }),
    ).toBe('running')
  })

  it('takes what the server says over what the text looks like', () => {
    expect(
      subagentOutcome({
        status: 'done',
        result: 'Error: this is the report quoting an error',
        toolUseResult: { status: 'completed' },
      }),
    ).toBe('completed')
    expect(
      subagentOutcome({
        status: 'done',
        result: 'Error: Subagent stopped by user.',
        toolUseResult: { status: 'stopped' },
      }),
    ).toBe('stopped')
  })

  it('reads sessions saved without a status off the result text', () => {
    const done = result => subagentOutcome({ status: 'done', result })
    expect(done('Found 3 routes.')).toBe('completed')
    expect(done('Error: Subagent stopped by user.')).toBe('stopped')
    // With where its changes were left appended.
    expect(done('Error: Subagent stopped by user.\n\nKept worktree …')).toBe(
      'stopped',
    )
    expect(done('Error: model unavailable')).toBe('error')
    expect(done('Async agent launched successfully.\nagentId: a1 (…)')).toBe(
      'background',
    )
    expect(subagentOutcome({ status: 'done', toolUseResult: {} })).toBe(
      'completed',
    )
  })

  it('counts a call cut off with its turn as stopped, not failed', () => {
    expect(
      subagentOutcome({
        status: 'done',
        isError: true,
        result: 'Interrupted by user',
      }),
    ).toBe('stopped')
    expect(
      subagentOutcome({ status: 'done', isError: true, result: 'boom' }),
    ).toBe('error')
  })
})

describe('subagentStatusLine', () => {
  it('says how a finished call ended', () => {
    const line = part =>
      subagentStatusLine({ status: 'done', ...part }, [], 'T')
    expect(line({ result: 'Found 3 routes.' })).toBe('Completed')
    expect(line({ result: 'Error: Subagent stopped by user.' })).toBe('Stopped')
    expect(line({ result: 'Error: model unavailable' })).toBe(
      'Stopped with error',
    )
    expect(line({ toolUseResult: { status: 'background' } })).toBe(
      'Started in the background',
    )
  })
})

describe('subagentAgentId', () => {
  it('finds the id wherever the call carries it', () => {
    expect(subagentAgentId({ toolUseResult: { agentId: 'afromresult' } })).toBe(
      'afromresult',
    )
    // Named on the first step, before there is a result.
    expect(subagentAgentId({ status: 'running', agentId: 'alive0001' })).toBe(
      'alive0001',
    )
    // SendMessage continues the agent it is addressed to.
    expect(
      subagentAgentId({ name: 'SendMessage', args: { to: 'aresumed1' } }),
    ).toBe('aresumed1')
  })

  it('reads it off the result text of sessions saved without one', () => {
    expect(
      subagentAgentId({ status: 'done', result: `Found 3 routes.${RESUME}` }),
    ).toBe('a1b2c3d4e')
    expect(
      subagentAgentId({
        status: 'done',
        result:
          'Async agent launched successfully.\nagentId: abg000001 (internal ID - do not mention to user.)',
      }),
    ).toBe('abg000001')
  })

  it('is null when there is none, or it is not an agent id', () => {
    expect(subagentAgentId({ status: 'done', result: 'Found 3 routes.' })).toBe(
      null,
    )
    expect(subagentAgentId({ toolUseResult: { agentId: '../etc' } })).toBe(null)
    expect(subagentAgentId(null)).toBe(null)
  })
})

describe('subagentReport', () => {
  it('leaves out the line addressed to the model', () => {
    expect(
      subagentReport({ status: 'done', result: `Found 3 routes.${RESUME}` }),
    ).toBe('Found 3 routes.')
  })

  it('shows a failure as it is', () => {
    expect(
      subagentReport({ status: 'done', result: 'Error: model unavailable' }),
    ).toBe('Error: model unavailable')
  })

  it('shows of a stop only what was added to it', () => {
    expect(
      subagentReport({
        status: 'done',
        result: 'Error: Subagent stopped by user.',
      }),
    ).toBe('')
    expect(
      subagentReport({
        status: 'done',
        result:
          'Error: Subagent stopped by user.\n\nChanges kept in worktree /tmp/wt',
      }),
    ).toBe('Changes kept in worktree /tmp/wt')
  })

  it('has none for a running call or a background launch', () => {
    expect(subagentReport({ status: 'running', result: 'x' })).toBe('')
    expect(
      subagentReport({
        status: 'done',
        result: 'Async agent launched successfully.',
      }),
    ).toBe('')
  })
})

describe('subagentConversation', () => {
  it('keeps what the agent said between its tool steps, in order', () => {
    const segments = subagentConversation([
      said('text:0', 'Looking at the router.'),
      read('a'),
      read('b'),
      said('text:3', 'Now the handlers.'),
      read('c', 'running'),
    ])
    expect(
      segments.map(s =>
        s.type === 'text' ? s.content : s.steps.map(x => x.toolCallId),
      ),
    ).toEqual([
      'Looking at the router.',
      ['a', 'b'],
      'Now the handlers.',
      ['c'],
    ])
    expect(new Set(segments.map(s => s.key)).size).toBe(segments.length)
  })

  it('skips blank text and bookkeeping tools without splitting a run', () => {
    const segments = subagentConversation([
      read('a'),
      said('text:1', '\n  '),
      { type: 'tool_call', toolCallId: 't', name: 'TodoWrite', status: 'done' },
      read('b'),
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0].steps.map(s => s.toolCallId)).toEqual(['a', 'b'])
  })

  it('can leave out the final text, which is the report', () => {
    const parts = [read('a'), said('text:1', 'Found 3 routes.')]
    expect(subagentConversation(parts)).toHaveLength(2)
    expect(
      subagentConversation(parts, { dropFinalText: true }).map(s => s.type),
    ).toEqual(['tools'])
    // Text followed by more work is not the report.
    expect(
      subagentConversation([said('text:0', 'Starting.'), read('a')], {
        dropFinalText: true,
      }).map(s => s.type),
    ).toEqual(['text', 'tools'])
  })

  it('is empty for a call with nothing nested', () => {
    expect(subagentConversation(undefined)).toEqual([])
  })
})

describe('subagentCallBubbles', () => {
  it('shows a running agent: its prompt and what has streamed in', () => {
    const bubbles = subagentCallBubbles({
      status: 'running',
      args: { prompt: 'List every HTTP route.' },
      subagentParts: [said('text:0', 'Looking.'), read('a', 'running')],
    })
    expect(bubbles.map(b => b.kind)).toEqual(['user', 'assistant_text', 'tool'])
    expect(bubbles[0].content).toBe('List every HTTP route.')
    expect(bubbles[2]).toMatchObject({
      id: 'tool:a',
      toolCallId: 'a',
      name: 'Read',
      status: 'running',
    })
  })

  it('times the prompt of a finished call by how long the call took', () => {
    const call = {
      args: { prompt: 'List every HTTP route.' },
      startTime: 1_000,
      endTime: 11_500,
    }
    expect(
      subagentCallBubbles({ ...call, status: 'done', result: 'Found 3.' })[0],
    ).toMatchObject({ turnStartTime: 1_000, turnEndTime: 11_500 })
    // Still running: it has not taken any time yet.
    const [prompt] = subagentCallBubbles({ ...call, status: 'running' })
    expect(prompt).not.toHaveProperty('turnStartTime')
    expect(prompt).not.toHaveProperty('turnEndTime')
  })

  it('ends a finished one with its report, said once', () => {
    const bubbles = subagentCallBubbles({
      status: 'done',
      args: { prompt: 'List every HTTP route.' },
      result: `Found 3 routes.${RESUME}`,
      subagentParts: [read('a'), said('text:1', 'Found 3 routes.')],
    })
    expect(bubbles.map(b => b.kind)).toEqual(['user', 'tool', 'assistant_text'])
    expect(bubbles[2].content).toBe('Found 3 routes.')
  })

  it('keeps what a failed agent said last, and shows the failure after it', () => {
    const bubbles = subagentCallBubbles({
      status: 'done',
      args: { message: 'Go on.' },
      result: 'Error: model unavailable',
      subagentParts: [said('text:0', 'Checking one more file.')],
    })
    expect(bubbles.map(b => b.kind)).toEqual([
      'user',
      'assistant_text',
      'error',
    ])
    expect(bubbles[2].message).toBe('Error: model unavailable')
  })
})

describe('subagentTurns', () => {
  const tool = (id, name = 'Read') => ({
    id: `tool:${id}`,
    kind: 'tool',
    toolCallId: id,
    name,
    args: { file_path: `src/${id}.ts` },
    status: 'done',
  })
  const said = (id, content) => ({ id, kind: 'assistant_text', content })
  const stepsOf = turn =>
    turn.steps.map(el =>
      el.type === 'bubble' ? el.bubbleId : [el.type, ...el.memberIds],
    )

  it('splits a finished run into its task, its steps and its result', () => {
    const { byId, turns } = subagentTurns([
      { id: 'u', kind: 'user', turnStartTime: 1_000, turnEndTime: 11_500 },
      tool('a', 'Grep'),
      tool('b', 'Grep'),
      said('note', 'One more look.'),
      tool('c', 'Bash'),
      said('answer', 'Found 3 routes.'),
    ])
    expect(turns).toHaveLength(1)
    const [turn] = turns
    expect(turn.prompt.id).toBe('u')
    expect(stepsOf(turn)).toEqual([
      ['tool_group', 'tool:a', 'tool:b'],
      'note',
      'tool:c',
    ])
    // Tool calls, not rows: what it said in between is not a step.
    expect(turn.stepCount).toBe(3)
    expect(turn.result.id).toBe('answer')
    expect(turn).toMatchObject({
      live: false,
      startedAt: 1_000,
      endedAt: 11_500,
      durationMs: 10_500,
    })
    expect(byId['tool:c'].name).toBe('Bash')
  })

  it('has no result yet for a run still under way', () => {
    const { turns } = subagentTurns(
      [
        { id: 'u', kind: 'user' },
        said('note', 'Looking.'),
        tool('a', 'Grep'),
        tool('b', 'Grep'),
      ],
      { running: true },
    )
    expect(turns[0]).toMatchObject({ live: true, result: null, stepCount: 2 })
    expect(stepsOf(turns[0])).toEqual([
      'note',
      ['tool_group', 'tool:a', 'tool:b'],
    ])
    // The run of searches it is in may still grow.
    expect(turns[0].steps.at(-1).live).toBe(true)
  })

  it('keeps what it last said as a step while it is still working', () => {
    const { turns } = subagentTurns(
      [{ id: 'u', kind: 'user' }, tool('a'), said('note', 'Almost there.')],
      { running: true },
    )
    expect(turns[0].result).toBeNull()
    expect(stepsOf(turns[0])).toEqual(['tool:a', 'note'])
  })

  it('leaves out the question a stopped agent has nobody to answer', () => {
    const { byId, turns } = subagentTurns([
      { id: 'u', kind: 'user' },
      tool('a', 'Grep'),
      { id: 'i', kind: 'interrupted' },
      tool('b', 'Grep'),
    ])
    // The marker goes, and does not split the run of steps around it.
    expect(stepsOf(turns[0])).toEqual([['tool_group', 'tool:a', 'tool:b']])
    expect(turns[0].result).toBeNull()
    expect(byId.i).toBeUndefined()
  })

  it('ends a failed run on its error', () => {
    const { turns } = subagentTurns([
      { id: 'u', kind: 'user' },
      said('note', 'Checking one more file.'),
      { id: 'report', kind: 'error', message: 'Error: model unavailable' },
    ])
    expect(stepsOf(turns[0])).toEqual(['note'])
    expect(turns[0].result).toMatchObject({ kind: 'error' })
  })

  it('gives each time a continued agent was asked a turn of its own', () => {
    const { turns } = subagentTurns(
      [
        { id: 'u1', kind: 'user', turnStartTime: 1_000, turnEndTime: 5_000 },
        tool('a'),
        said('answer1', 'First.'),
        { id: 'u2', kind: 'user' },
        tool('b'),
      ],
      { running: true },
    )
    expect(turns.map(t => t.key)).toEqual(['turn:0', 'turn:1'])
    // Only the last one is still running.
    expect(turns[0]).toMatchObject({ live: false, durationMs: 4_000 })
    expect(turns[0].result.id).toBe('answer1')
    expect(turns[1]).toMatchObject({
      live: true,
      result: null,
      durationMs: undefined,
    })
  })

  it('holds what came before any task in a turn without one', () => {
    const { turns } = subagentTurns([said('answer', 'Nothing to do.')])
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBeNull()
    expect(turns[0].result.id).toBe('answer')
    expect(subagentTurns([]).turns).toEqual([])
    expect(subagentTurns(undefined).turns).toEqual([])
  })
})

describe('subagentSummary', () => {
  it('adds up the runs', () => {
    const { turns } = subagentTurns([
      { id: 'u1', kind: 'user', turnStartTime: 1_000, turnEndTime: 5_000 },
      { id: 'tool:a', kind: 'tool', name: 'Read' },
      { id: 'a1', kind: 'assistant_text', content: 'First.' },
      { id: 'u2', kind: 'user', turnStartTime: 60_000, turnEndTime: 71_000 },
      { id: 'tool:b', kind: 'tool', name: 'Read' },
      { id: 'tool:c', kind: 'tool', name: 'Bash' },
      { id: 'a2', kind: 'assistant_text', content: 'Second.' },
    ])
    expect(subagentSummary(turns)).toEqual({
      stepCount: 3,
      // Time worked, not the hour between the two questions.
      durationMs: 15_000,
      startedAt: 1_000,
      endedAt: 71_000,
    })
  })

  it('has no times for runs whose timing was not kept', () => {
    const { turns } = subagentTurns([{ id: 'u', kind: 'user' }])
    const none = {
      stepCount: 0,
      durationMs: undefined,
      startedAt: undefined,
      endedAt: undefined,
    }
    expect(subagentSummary(turns)).toEqual(none)
    expect(subagentSummary([])).toEqual(none)
  })
})

describe('subagentDurationLabel', () => {
  it.each([
    [1, '1s'],
    [5_200, '6s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [125_000, '2m 5s'],
    [3_600_000, '1h'],
    [3_780_000, '1h 3m'],
  ])('%ims', (ms, label) => {
    expect(subagentDurationLabel(ms)).toBe(label)
  })

  it('is empty for no time at all', () => {
    expect(subagentDurationLabel(0)).toBe('')
    expect(subagentDurationLabel(undefined)).toBe('')
    expect(subagentDurationLabel(-5)).toBe('')
  })
})

describe('subagentTimeLabel', () => {
  const NOW = 1_700_000_000_000
  const SEC = 1000
  const MIN = 60 * SEC
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it.each([
    [0, 'Now', 'Just now'],
    [59 * SEC, 'Now', 'Just now'],
    [MIN, '1m', '1m ago'],
    [59 * MIN, '59m', '59m ago'],
    [2 * HOUR, '2h', '2h ago'],
    [3 * DAY, '3d', '3d ago'],
    [65 * DAY, '2mo', '2mo ago'],
    [800 * DAY, '2y', '2y ago'],
  ])('%ims ago', (elapsed, short, ago) => {
    expect(subagentTimeLabel(NOW - elapsed, NOW)).toBe(short)
    expect(subagentTimeLabel(NOW - elapsed, NOW, { ago: true })).toBe(ago)
  })

  it('treats a clock that is behind as now, and no time as nothing', () => {
    expect(subagentTimeLabel(NOW + 5 * MIN, NOW)).toBe('Now')
    expect(subagentTimeLabel(undefined, NOW)).toBe('')
    expect(subagentTimeLabel(Number.NaN, NOW, { ago: true })).toBe('')
  })
})
