/**
 * SSE parser for the agent backend wire format (browser).
 *
 * Kept local to `web` on purpose: `@ai-agent/client` is for headless
 * callers. The SDK has its own `parseSSE` — keep wire shape in sync if either
 * changes.
 */

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<object>}
 */
export async function* parseSSE(stream, signal) {
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

      let sep
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

/** @param {string} raw */
function parseOneEvent(raw) {
  let dataLine = ''
  let eventId = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLine = line.slice(5).trim()
    if (line.startsWith('id:')) eventId = line.slice(3).trim()
  }
  if (!dataLine) return null

  try {
    const parsed = JSON.parse(dataLine)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.type === 'string'
    ) {
      if (eventId) {
        Object.defineProperty(parsed, '__eventId', {
          value: eventId,
          enumerable: false,
        })
      }
      return parsed
    }
  } catch {
    return { type: 'unknown', data: dataLine }
  }
  return null
}
