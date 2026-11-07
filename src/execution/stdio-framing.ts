/**
 * NDJSON framing for RuntimePort over stdio (one JSON object per line).
 */
import type { Readable, Writable } from 'stream'
import { StringDecoder } from 'string_decoder'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
} from './runtime-protocol.js'

export type AnyRuntimeMessage = RuntimeClientMessage | RuntimeServerMessage

export function writeNdjson(stream: Writable, msg: AnyRuntimeMessage): void {
  stream.write(`${JSON.stringify(msg)}\n`)
}

/**
 * Attach a line-oriented JSON parser to a readable stream.
 * Returns an unsubscribe function.
 */
export function onNdjsonLines(
  stream: Readable,
  onMessage: (msg: AnyRuntimeMessage) => void,
  onError?: (err: Error) => void,
): () => void {
  // Multi-MB lines (readBytes base64) arrive in many chunks: keep partial
  // pieces in an array and only scan the newest chunk, so a line costs O(n).
  const decoder = new StringDecoder('utf8')
  let partial: string[] = []
  const onData = (chunk: Buffer | string) => {
    let rest = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let idx: number
    while ((idx = rest.indexOf('\n')) >= 0) {
      partial.push(rest.slice(0, idx))
      rest = rest.slice(idx + 1)
      const line = partial.join('').replace(/\r$/, '')
      partial = []
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line) as AnyRuntimeMessage)
      } catch (err) {
        onError?.(
          err instanceof Error
            ? err
            : new Error(`Invalid NDJSON from worker: ${line.slice(0, 200)}`),
        )
      }
    }
    if (rest) partial.push(rest)
  }
  stream.on('data', onData)
  return () => {
    stream.off('data', onData)
  }
}
