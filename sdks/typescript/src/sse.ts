/**
 * SSE parser and stream helpers for the agent backend wire format.
 * Messages are `@ai-agent/protocol` JSON bodies over SSE.
 */

import { AgentClientError } from './errors.js'
import type { AgentEvent } from './types.js'

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const onAbort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort)

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const ev = parseOneEvent(raw)
        if (ev) yield ev
      }
    }
    if (buffer.trim().length > 0) {
      const ev = parseOneEvent(buffer)
      if (ev) yield ev
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

/** Drain an event stream; prefer result.text, else join stream_event text deltas. */
export async function collectText(
  events: AsyncIterable<AgentEvent>,
): Promise<string> {
  const deltas: string[] = []
  let final: string | undefined

  for await (const ev of events) {
    if (ev.type === 'stream_event') {
      const delta = ev.delta as { kind?: string; text?: string } | undefined
      if (delta?.kind === 'text' && typeof delta.text === 'string') {
        deltas.push(delta.text)
      }
    }
    if (
      ev.type === 'result' &&
      ev.subtype === 'success' &&
      typeof ev.text === 'string'
    ) {
      final = ev.text
    }
    if (ev.type === 'result' && ev.subtype === 'error') {
      throw new AgentClientError(String(ev.error ?? 'stream error'), 0, ev)
    }
  }

  return final ?? deltas.join('')
}

function parseOneEvent(raw: string): AgentEvent | null {
  let dataLine = ''
  let eventId: string | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLine = line.slice(5).trim()
    if (line.startsWith('id:')) eventId = line.slice(3).trim()
  }
  if (!dataLine) return null

  try {
    const parsed = JSON.parse(dataLine) as AgentEvent
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.type === 'string'
    ) {
      if (eventId) parsed.event_id = eventId
      return parsed
    }
  } catch {
    return { type: 'unknown', data: dataLine }
  }
  return null
}
