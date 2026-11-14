import { describe, expect, it, vi } from 'vitest'
import { applySseEvent } from './apply-sse-event.js'

function context(initial = {}) {
  let state = { ...initial }
  return {
    get state() {
      return state
    },
    ctx: {
      get: () => state,
      set: patch => {
        state = { ...state, ...patch }
      },
      mutators: {
        _appendPart: vi.fn(),
        _removeThinking: vi.fn(),
      },
    },
  }
}

describe('turn state SSE reduction', () => {
  it('applies server activity details', () => {
    const target = context()
    applySseEvent(
      {
        type: 'system',
        subtype: 'turn_state',
        state: 'preparing',
        detail_code: 'mcp.connect',
        label: 'Connecting tools',
      },
      target.ctx,
    )

    expect(target.state).toMatchObject({
      turnState: 'preparing',
      turnDetail: 'mcp.connect',
      turnStateLabel: 'Connecting tools',
    })
  })

  it('returns to idle on terminal events for older servers and replays', () => {
    const target = context({ turnState: 'responding' })
    applySseEvent(
      { type: 'result', subtype: 'success', reason: 'done' },
      target.ctx,
    )

    expect(target.state.turnState).toBe('idle')
    expect(target.ctx.mutators._removeThinking).toHaveBeenCalledOnce()
  })
})

describe('tool use summary SSE reduction', () => {
  it('hands the label and its tool calls to the transcript', () => {
    const target = context()
    target.ctx.mutators._setToolUseSummary = vi.fn()
    const event = {
      type: 'system',
      subtype: 'tool_use_summary',
      summary: 'Read config.json',
      preceding_tool_use_ids: ['read-1'],
    }

    applySseEvent(event, target.ctx)

    expect(target.ctx.mutators._setToolUseSummary).toHaveBeenCalledWith(event)
  })
})
