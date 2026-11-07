import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { onNdjsonLines, type AnyRuntimeMessage } from './stdio-framing.js'

function collect() {
  const stream = new PassThrough()
  const messages: AnyRuntimeMessage[] = []
  onNdjsonLines(stream, msg => messages.push(msg))
  return { stream, messages }
}

describe('onNdjsonLines', () => {
  it('keeps a multi-byte character split across chunks intact', () => {
    const { stream, messages } = collect()
    const line = Buffer.from(
      `${JSON.stringify({ type: 'error', message: '读取失败' })}\n`,
    )
    const cut = line.indexOf(Buffer.from('读')) + 1
    stream.write(line.subarray(0, cut))
    stream.write(line.subarray(cut))

    expect(messages).toEqual([{ type: 'error', message: '读取失败' }])
  })

  it('reassembles one large line from many chunks', () => {
    const { stream, messages } = collect()
    const payload = 'a'.repeat(3 * 1024 * 1024)
    const line = `${JSON.stringify({ type: 'error', message: payload })}\n{"type":"pong","id":"x"}\n`
    for (let i = 0; i < line.length; i += 64 * 1024) {
      stream.write(line.slice(i, i + 64 * 1024))
    }

    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ type: 'error', message: payload })
    expect(messages[1]).toEqual({ type: 'pong', id: 'x' })
  })
})
