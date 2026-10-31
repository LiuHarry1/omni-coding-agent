import type { ServerResponse } from 'http'
import type { OutgoingMessage } from '../../../protocol/src/wire.js'
import type { SSETransport } from '../../core/types.js'
import { appendRunEvent, readRunEvents } from './run-store.js'
import type { DurableRunState, StoredRunEvent } from './types.js'
import { isTerminalRunStatus } from './types.js'

const KEEP_ALIVE_MS = 20_000

function protocolEventName(msg: OutgoingMessage): string {
  if (msg.type === 'control_request' || msg.type === 'control_response') {
    return msg.type
  }
  return 'subtype' in msg && typeof msg.subtype === 'string'
    ? `${msg.type}.${msg.subtype}`
    : msg.type
}

function serializeEvent(event: StoredRunEvent): string {
  const payload = JSON.stringify(event.event).replace(/\u2028|\u2029/g, c =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
  return (
    `id: ${event.seq}\n` +
    `event: ${protocolEventName(event.event)}\n` +
    `data: ${payload}\n\n`
  )
}

type Subscriber = {
  res: ServerResponse
  keepAlive: ReturnType<typeof setInterval>
}

export class DurableRunTransport implements SSETransport {
  private subscribers = new Set<Subscriber>()
  private terminalScopes = new Set<string>()
  private ended = false

  constructor(
    readonly state: DurableRunState,
    private readonly onEmit?: (
      state: DurableRunState,
      event: StoredRunEvent,
    ) => void,
  ) {}

  emit(msg: OutgoingMessage): void {
    if (this.ended) return
    if (msg.type === 'result') {
      const parentId =
        'parent_tool_use_id' in msg &&
        typeof msg.parent_tool_use_id === 'string'
          ? msg.parent_tool_use_id
          : undefined
      const scope = parentId ? `parent:${parentId}` : 'root'
      if (this.terminalScopes.has(scope)) return
      this.terminalScopes.add(scope)
    }
    const event: StoredRunEvent = {
      version: 1,
      runId: this.state.runId,
      seq: ++this.state.lastSeq,
      timestamp: Date.now(),
      event: msg,
    }
    appendRunEvent(this.state, event)
    this.onEmit?.(this.state, event)
    const frame = serializeEvent(event)
    for (const subscriber of [...this.subscribers]) {
      if (!this.write(subscriber.res, frame)) this.remove(subscriber)
    }
  }

  attachSSE(
    res: ServerResponse,
    afterSeq = 0,
    extraHeaders: Record<string, string> = {},
  ): () => void {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Agent-Protocol': '1',
        'X-Run-Id': this.state.runId,
        'X-Session-Id': this.state.sessionId,
        ...extraHeaders,
      })
    }
    if (!this.write(res, ': connected\n\n')) return () => {}
    for (const event of readRunEvents(this.state, afterSeq)) {
      if (!this.write(res, serializeEvent(event))) return () => {}
    }

    if (this.ended || isTerminalRunStatus(this.state.status)) {
      if (!res.writableEnded) res.end()
      return () => {}
    }

    const subscriber: Subscriber = {
      res,
      keepAlive: setInterval(() => {
        if (!this.write(res, ': keep-alive\n\n')) this.remove(subscriber)
      }, KEEP_ALIVE_MS),
    }
    subscriber.keepAlive.unref?.()
    this.subscribers.add(subscriber)

    const cleanup = () => this.remove(subscriber)
    res.once('close', cleanup)
    res.once('error', cleanup)
    return cleanup
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const subscriber of [...this.subscribers]) {
      this.remove(subscriber)
      if (!subscriber.res.writableEnded) subscriber.res.end()
    }
  }

  private write(res: ServerResponse, value: string): boolean {
    if (res.writableEnded || res.destroyed) return false
    try {
      res.write(value)
      return true
    } catch {
      try {
        res.destroy()
      } catch {
        // Already closed.
      }
      return false
    }
  }

  private remove(subscriber: Subscriber): void {
    clearInterval(subscriber.keepAlive)
    this.subscribers.delete(subscriber)
  }
}
