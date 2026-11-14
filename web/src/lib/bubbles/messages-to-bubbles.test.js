import { describe, expect, it } from 'vitest'
import {
  messagesToBubbles,
  persistedSubagentProjection,
  toolBubbleId,
  toolBubbleToPart,
} from './messages-to-bubbles.js'

describe('persisted subagent projection', () => {
  const persisted = {
    version: 1,
    steps: [
      {
        type: 'tool_call',
        toolCallId: 'nested-1',
        name: 'Read',
        args: { file_path: 'a.ts' },
        status: 'done',
        result: 'ok',
      },
    ],
    omittedSteps: 2,
  }

  it('hydrates nested steps and omission metadata', () => {
    const state = messagesToBubbles([
      {
        type: 'assistant',
        id: 'turn-1',
        status: 'done',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'agent-1',
            name: 'Agent',
            isSubagent: true,
            status: 'done',
            toolUseResult: { text: 'done', ui: persisted },
          },
        ],
      },
    ])
    expect(state.bubblesById[toolBubbleId('agent-1')]).toMatchObject({
      subagentParts: persisted.steps,
      omittedSubagentSteps: 2,
    })
  })

  it('prefers live nested steps over persisted projection', () => {
    const live = [
      {
        type: 'tool_call',
        toolCallId: 'live-1',
        name: 'Glob',
        status: 'done',
      },
    ]
    const state = messagesToBubbles([
      {
        type: 'assistant',
        id: 'turn-1',
        status: 'done',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'agent-1',
            name: 'Agent',
            isSubagent: true,
            status: 'done',
            subagentParts: live,
            toolUseResult: { text: 'done', ui: persisted },
          },
        ],
      },
    ])
    expect(state.bubblesById[toolBubbleId('agent-1')].subagentParts).toEqual(
      live,
    )
  })

  it('rejects malformed projections', () => {
    expect(
      persistedSubagentProjection({
        toolUseResult: { ui: { version: 2, steps: [] } },
      }),
    ).toBeNull()
  })
})

describe('tool batch labels', () => {
  it('keeps the label of a reloaded tool call and hands it to the card part', () => {
    const state = messagesToBubbles([
      {
        type: 'assistant',
        id: 'turn-1',
        status: 'done',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'read-1',
            name: 'Read',
            status: 'done',
            batchSummary: 'Read config.json',
          },
          { type: 'tool_call', toolCallId: 'read-2', name: 'Read' },
        ],
      },
    ])

    expect(state.bubblesById[toolBubbleId('read-1')].batchSummary).toBe(
      'Read config.json',
    )
    expect(
      state.bubblesById[toolBubbleId('read-2')].batchSummary,
    ).toBeUndefined()
    expect(
      toolBubbleToPart(state.bubblesById[toolBubbleId('read-1')]).batchSummary,
    ).toBe('Read config.json')
  })
})

describe('queued messages and task notifications', () => {
  it('marks a reloaded message that was sent mid-turn', () => {
    const { bubbleOrder, bubblesById } = messagesToBubbles([
      { type: 'user', id: 'u1', content: 'fix a' },
      { type: 'user', id: 'u2', content: 'also b', queued: true },
    ])

    expect(bubblesById.u1.queued).toBeUndefined()
    expect(bubblesById.u2).toMatchObject({
      kind: 'user',
      content: 'also b',
      queued: true,
    })
    expect(bubbleOrder).toEqual(['u1', 'u2'])
  })

  it('turns a task notification turn into a notice bubble', () => {
    const { bubblesById } = messagesToBubbles([
      {
        type: 'task_notification',
        id: 'n1',
        summaries: ['Agent "audit" completed'],
      },
      { type: 'task_notification', id: 'n2' },
    ])

    expect(bubblesById.n1).toEqual({
      id: 'n1',
      kind: 'task_notification',
      summaries: ['Agent "audit" completed'],
    })
    expect(bubblesById.n2.summaries).toEqual([])
  })
})
