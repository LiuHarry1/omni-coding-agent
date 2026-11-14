import { describe, expect, it } from 'vitest'
import { workGroupSummaries } from './flat-elements.js'

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
