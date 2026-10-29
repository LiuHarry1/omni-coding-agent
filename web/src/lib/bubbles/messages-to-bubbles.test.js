import { describe, expect, it } from 'vitest'
import {
  messagesToBubbles,
  persistedSubagentProjection,
  toolBubbleId,
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
