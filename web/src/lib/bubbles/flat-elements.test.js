import { describe, expect, it } from 'vitest'
import { buildFlatElements, workGroupSummaries } from './flat-elements.js'

const tool = (id, batchSummary) => ({ id, kind: 'tool', batchSummary })

describe('workGroupSummaries', () => {
  it('lists the labels of a work group in order', () => {
    const byId = {
      a: tool('a', 'Searched in auth/'),
      b: tool('b', 'Fixed NPE in UserService'),
    }

    expect(workGroupSummaries(['a', 'b'], byId)).toEqual([
      'Searched in auth/',
      'Fixed NPE in UserService',
    ])
  })

  it('counts the shared label of one batch once', () => {
    const byId = {
      a: tool('a', 'Read two files'),
      b: tool('b', 'Read two files'),
      c: tool('c', 'Ran tests'),
      d: tool('d', 'Read two files'),
    }

    // The same wording for a later batch is a different step and stays.
    expect(workGroupSummaries(['a', 'b', 'c', 'd'], byId)).toEqual([
      'Read two files',
      'Ran tests',
      'Read two files',
    ])
  })

  it('skips tools without a label and rows that are not tools', () => {
    const byId = {
      a: tool('a', 'Ran tests'),
      b: tool('b'),
      c: tool('c', '   '),
      d: { id: 'd', kind: 'reasoning', batchSummary: 'not a tool' },
    }

    expect(workGroupSummaries(['a', 'b', 'c', 'd', 'missing'], byId)).toEqual([
      'Ran tests',
    ])
  })

  it('is empty for a group without labels', () => {
    expect(workGroupSummaries(['a'], { a: tool('a') })).toEqual([])
    expect(workGroupSummaries(undefined, {})).toEqual([])
  })
})

describe('buildFlatElements turn boundaries', () => {
  const text = (id, turnId, content) => ({
    id,
    kind: 'assistant_text',
    turnId,
    content,
  })
  const toolRow = (id, turnId) => ({
    id,
    kind: 'tool',
    turnId,
    name: 'Bash',
    status: 'done',
    args: { command: 'npm test' },
  })

  const reasoning = (id, turnId) => ({
    id,
    kind: 'reasoning',
    turnId,
    content: 'Checking the results.',
  })

  it('starts a new stretch of work at a task notification', () => {
    const byId = {
      u1: { id: 'u1', kind: 'user', content: 'start the audit' },
      a1: text('a1', 't1', 'Launched.'),
      n1: { id: 'n1', kind: 'task_notification', summaries: ['done'] },
      r1: reasoning('r1', 't2'),
      w1: toolRow('w1', 't2'),
      a2: text('a2', 't2', 'All clear.'),
    }

    const rows = buildFlatElements(['u1', 'a1', 'n1', 'r1', 'w1', 'a2'], byId)

    // The notice is a row of its own; the work after it folds separately
    // from the reply before it.
    expect(rows.map(r => r.bubbleId ?? r.type)).toEqual([
      'u1',
      'a1',
      'n1',
      'work_group',
      'a2',
    ])
    expect(rows[3]).toMatchObject({ turnId: 't2', memberIds: ['r1', 'w1'] })
  })

  it('splits the work around a message sent mid-turn', () => {
    const byId = {
      u1: { id: 'u1', kind: 'user', content: 'fix a' },
      w1: toolRow('w1', 't1'),
      u2: { id: 'u2', kind: 'user', content: 'also b', queued: true },
      r2: reasoning('r2', 't2'),
      w2: toolRow('w2', 't2'),
      a2: text('a2', 't2', 'Both done.'),
    }

    const rows = buildFlatElements(['u1', 'w1', 'u2', 'r2', 'w2', 'a2'], byId)

    expect(rows.map(r => r.bubbleId ?? r.type)).toEqual([
      'u1',
      'w1',
      'u2',
      'work_group',
      'a2',
    ])
  })
})
