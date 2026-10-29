import { describe, expect, it } from 'vitest'
import type { Message } from '../../core/types.js'
import { buildAgentUiProjection } from './uiProjection.js'

describe('buildAgentUiProjection', () => {
  it('pairs calls with bounded results and structured details', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'Read',
            input: { file_path: 'a.ts' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'Read',
            output: { type: 'text', value: `Error: ${'x'.repeat(3_000)}` },
            toolUseResult: { file: { filePath: 'a.ts', content: 'secret' } },
            isError: true,
          },
        ],
      },
    ]

    const projection = buildAgentUiProjection(messages)
    expect(projection?.version).toBe(1)
    expect(projection?.steps).toHaveLength(1)
    expect(projection?.steps[0]).toMatchObject({
      toolCallId: 'call-1',
      name: 'Read',
      status: 'done',
      isError: true,
    })
    expect(projection?.steps[0]?.result?.length).toBe(2_000)
    expect(projection?.detailsTruncated).toBe(true)
  })

  it('keeps the leading and newest steps within hard limits', () => {
    const calls = Array.from({ length: 120 }, (_, index) => ({
      type: 'tool-call' as const,
      toolCallId: `call-${index}`,
      toolName: 'Bash',
      input: { command: 'x'.repeat(5_000) },
    }))
    const messages: Message[] = [{ role: 'assistant', content: calls }]
    const projection = buildAgentUiProjection(messages)

    expect(projection).toBeDefined()
    expect(projection!.steps.length).toBeLessThanOrEqual(100)
    expect(projection!.steps.slice(0, 6).map(step => step.toolCallId)).toEqual(
      calls.slice(0, 6).map(call => call.toolCallId),
    )
    expect(projection!.steps.at(-1)?.toolCallId).toBe('call-119')
    expect(projection!.omittedSteps).toBeGreaterThan(0)
    expect(
      Buffer.byteLength(JSON.stringify(projection), 'utf-8'),
    ).toBeLessThanOrEqual(128 * 1024)
  })

  it('returns undefined when the subagent used no tools', () => {
    expect(
      buildAgentUiProjection([
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ]),
    ).toBeUndefined()
  })
})
