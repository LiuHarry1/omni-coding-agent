/**
 * Work-group + explore-coalesce checks against the live transcript path.
 * Run: npx tsx src/tests/test-work-fold.ts
 */
import assert from 'assert'
import { buildFlatElements } from '../../web/src/lib/bubbles/flat-elements.js'
import { formatWorkedDuration } from '../../web/src/lib/timeline.js'
import { coalesceToolRuns } from '../../web/src/lib/tool-density.js'

type Bubble = {
  id: string
  kind: string
  turnId?: string
  name?: string
  status?: string
  startTime?: number
  endTime?: number
  turnStartTime?: number
  turnEndTime?: number
  content?: string
}

type FlatOptions = {
  isStreaming?: boolean
  activeTurnId?: string | null
  unfoldLatestTurn?: boolean
}

type FlatElement = {
  type: string
  bubbleId: string
  state: string
  memberIds: string[]
  turnId: string | null
  defaultOpen: boolean
  durationMs: number
}

function flat(bubbles: Bubble[], opts: FlatOptions = {}): FlatElement[] {
  const bubbleOrder = bubbles.map(b => b.id)
  const bubblesById = Object.fromEntries(bubbles.map(b => [b.id, b]))
  return buildFlatElements(bubbleOrder, bubblesById, opts) as FlatElement[]
}

const tool = (id: string, extra: Partial<Bubble> = {}): Bubble => ({
  id,
  kind: 'tool',
  turnId: extra.turnId ?? 't1',
  name: extra.name ?? 'Bash',
  status: extra.status ?? 'done',
  startTime: extra.startTime ?? 1000,
  endTime: extra.endTime ?? 2000,
  ...extra,
})

{
  // Streaming: turn not completed — no workGroup; tools stay flat.
  const out = flat(
    [
      tool('a', { status: 'done' }),
      tool('b', { status: 'streaming-input', endTime: undefined }),
    ],
    { isStreaming: true, activeTurnId: 't1' },
  )
  assert.ok(out.every(r => r.type !== 'work_group'))
  assert.equal(out[0].type, 'bubble')
  assert.equal(out[0].bubbleId, 'a')
  assert.equal(out[1].type, 'bubble')
  assert.equal(out[1].bubbleId, 'b')
}

{
  // Streaming: thinking stays visible; still no Worked header.
  const out = flat([tool('a'), { id: 'th', kind: 'thinking', turnId: 't1' }], {
    isStreaming: true,
    activeTurnId: 't1',
  })
  assert.ok(out.every(r => r.type !== 'work_group'))
  assert.equal(out[0].bubbleId, 'a')
  assert.equal(out[1].bubbleId, 'th')
}

{
  // Done turn, single tool: unwrap the one-row workGroup.
  const out = flat(
    [
      tool('a', { startTime: 1000, endTime: 8000 }),
      {
        id: 't1-text',
        kind: 'assistant_text',
        turnId: 't1',
        content: '项目已启动',
      },
    ],
    { isStreaming: false },
  )
  assert.ok(out.every(r => r.type !== 'work_group'))
  assert.equal(out[0].type, 'bubble')
  assert.equal(out[0].bubbleId, 'a')
  assert.equal(out[1].bubbleId, 't1-text')
}

{
  // Done turn, two tools: keep Worked (more than one view row).
  const out = flat(
    [
      tool('a', { startTime: 1000, endTime: 4000 }),
      tool('b', { startTime: 4000, endTime: 8000 }),
      {
        id: 't1-text',
        kind: 'assistant_text',
        turnId: 't1',
        content: '项目已启动',
      },
    ],
    { isStreaming: false },
  )
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'work_group')
  assert.equal(out[0].state, 'completed')
  assert.deepEqual(out[0].memberIds, ['a', 'b'])
  assert.equal(out[1].bubbleId, 't1-text')
}

{
  // Worked spans the whole turn (send → finish), not just its tool calls.
  const out = flat(
    [
      {
        id: 'u1',
        kind: 'user',
        content: 'go',
        turnStartTime: 10_000,
        turnEndTime: 19_400,
      },
      tool('a', { startTime: 12_200, endTime: 13_000 }),
      tool('b', { startTime: 13_000, endTime: 15_400 }),
      { id: 'txt', kind: 'assistant_text', turnId: 't1', content: 'done' },
    ],
    { isStreaming: false },
  )
  const group = out.find(r => r.type === 'work_group')
  assert.equal(group?.durationMs, 9_400)
}

{
  // History has no turn timing: no duration rather than a partial one.
  const out = flat(
    [
      { id: 'u1', kind: 'user', content: 'go' },
      tool('a', { startTime: 12_200, endTime: 13_000 }),
      tool('b', { startTime: 13_000, endTime: 15_400 }),
      { id: 'txt', kind: 'assistant_text', turnId: 't1', content: 'done' },
    ],
    { isStreaming: false },
  )
  const group = out.find(r => r.type === 'work_group')
  assert.ok(group)
  assert.equal(group.durationMs, undefined)
}

{
  // Each Worked takes the timing of the user message that started its turn.
  const timedTurn = (turnId: string, start: number, end: number): Bubble[] => [
    {
      id: `${turnId}-u`,
      kind: 'user',
      content: 'go',
      turnStartTime: start,
      turnEndTime: end,
    },
    tool(`${turnId}-a`, { turnId }),
    tool(`${turnId}-b`, { turnId }),
    { id: `${turnId}-txt`, kind: 'assistant_text', turnId, content: 'ok' },
  ]
  const groups = flat([
    ...timedTurn('t1', 0, 4_000),
    ...timedTurn('t2', 10_000, 17_000),
  ]).filter(r => r.type === 'work_group')
  assert.deepEqual(
    groups.map(g => g.durationMs),
    [4_000, 7_000],
  )
}

{
  // Done turn: thinking placeholder stripped from fold body.
  const out = flat(
    [
      tool('a'),
      tool('b'),
      { id: 'th', kind: 'thinking', turnId: 't1' },
      { id: 'txt', kind: 'assistant_text', turnId: 't1', content: 'done' },
    ],
    { isStreaming: false },
  )
  assert.equal(out[0].type, 'work_group')
  assert.ok(!out[0].memberIds.includes('th'))
  assert.equal(out[1].bubbleId, 'txt')
}

{
  // Three Reads coalesce to one explore group → keep Worked.
  const out = flat(
    [
      tool('r1', { name: 'Read' }),
      tool('r2', { name: 'Read' }),
      tool('r3', { name: 'Read' }),
      { id: 'txt', kind: 'assistant_text', turnId: 't1', content: 'done' },
    ],
    { isStreaming: false },
  )
  assert.equal(out[0].type, 'work_group')
  assert.equal(out[1].bubbleId, 'txt')
}

{
  // Tool-only completed turn — no work_group (no final reply).
  const out = flat([tool('a')], { isStreaming: false })
  assert.ok(out.every(r => r.type !== 'work_group'))
}

{
  const turn = (turnId: string, userId: string): Bubble[] => [
    { id: userId, kind: 'user', turnId, content: 'go' },
    tool(`${turnId}-a`, { turnId, startTime: 1000, endTime: 2000 }),
    tool(`${turnId}-b`, { turnId, startTime: 2000, endTime: 3000 }),
    {
      id: `${turnId}-txt`,
      kind: 'assistant_text',
      turnId,
      content: 'ok',
    },
  ]

  // History hydrate: no unfoldLatestTurn → every Worked stays collapsed.
  const history = flat([...turn('t1', 'u1'), ...turn('t2', 'u2')])
  const historyGroups = history.filter(r => r.type === 'work_group')
  assert.equal(historyGroups.length, 2)
  assert.ok(historyGroups.every(g => g.defaultOpen !== true))

  // Watched this session: only the latest turn's Worked is defaultOpen.
  const live = flat([...turn('t1', 'u1'), ...turn('t2', 'u2')], {
    unfoldLatestTurn: true,
  })
  const liveGroups = live.filter(r => r.type === 'work_group')
  assert.equal(liveGroups.length, 2)
  assert.equal(liveGroups[0].turnId, 't1')
  assert.notEqual(liveGroups[0].defaultOpen, true)
  assert.equal(liveGroups[1].turnId, 't2')
  assert.equal(liveGroups[1].defaultOpen, true)

  // Latest still streaming: no Worked on t2; t1 stays collapsed.
  const streaming = flat(
    [
      ...turn('t1', 'u1'),
      { id: 'u2', kind: 'user', turnId: 't2', content: 'go' },
      tool('t2-a', { turnId: 't2' }),
      tool('t2-b', { turnId: 't2' }),
    ],
    { isStreaming: true, activeTurnId: 't2', unfoldLatestTurn: true },
  )
  const streamingGroups = streaming.filter(r => r.type === 'work_group')
  assert.equal(streamingGroups.length, 1)
  assert.equal(streamingGroups[0].turnId, 't1')
  assert.notEqual(streamingGroups[0].defaultOpen, true)
}

{
  assert.equal(formatWorkedDuration(500), 'for 1s')
  assert.equal(formatWorkedDuration(7000), 'for 7s')
  assert.equal(formatWorkedDuration(65000), 'for 1m 5s')
}

{
  const twoReads = coalesceToolRuns([
    { type: 'tool_call', name: 'Read' },
    { type: 'tool_call', name: 'Read' },
  ])
  assert.equal(twoReads.length, 2)
  assert.ok(twoReads.every(r => r.type === 'tool'))

  const threeReads = coalesceToolRuns([
    { type: 'tool_call', name: 'Read' },
    { type: 'tool_call', name: 'Read' },
    { type: 'tool_call', name: 'Read' },
  ])
  assert.equal(threeReads.length, 1)
  assert.equal(threeReads[0].type, 'explored_run')

  const twoGreps = coalesceToolRuns([
    { type: 'tool_call', name: 'Grep' },
    { type: 'tool_call', name: 'Grep' },
  ])
  assert.equal(twoGreps[0].type, 'explored_run')

  const twoBrowser = coalesceToolRuns([
    { type: 'tool_call', name: 'browser_navigate' },
    { type: 'tool_call', name: 'browser_click' },
  ])
  assert.equal(twoBrowser[0].type, 'browser_run')
}

console.log('work-fold tests OK')
