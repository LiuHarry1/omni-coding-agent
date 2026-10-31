/**
 * Chat SSE transport.
 *
 * HTTP via agentApi (SSO auth + response headers); SSE via local parseSSE.
 * Does not depend on `@ai-agent/client` (that package is for headless callers).
 */
import { parseSSE } from '../../lib/sse.js'
import { agentApi } from '../../lib/api/agent.js'

/**
 * @typedef {{
 *   sessionId: string | null,
 *   runId: string | null,
 *   lastSeq: number,
 *   permissionMode: string | null,
 *   agentType: string | undefined,
 * }} ChatStreamMeta
 */

/**
 * Open POST /chat, parse SSE, invoke onEvent for each protocol message.
 *
 * @param {{
 *   body: Record<string, unknown>,
 *   signal: AbortSignal,
 *   onEvent: (data: object) => void,
 *   onOpen?: (meta: ChatStreamMeta) => void,
 *   onReconnecting?: (meta: ChatStreamMeta) => void,
 *   onHttpError: (info: { status: number, message: string }) => void,
 *   onSessionNotFound?: () => void,
 * }} opts
 * @returns {Promise<ChatStreamMeta | null>} meta after successful stream open; null if aborted by HTTP error handler
 */
export async function streamChatTurn({
  body,
  signal,
  onEvent,
  onOpen,
  onReconnecting,
  onHttpError,
  onSessionNotFound,
}) {
  const postChat = sessionId =>
    agentApi.postChat({ ...body, session_id: sessionId }, signal)

  let res = await postChat(body.session_id ?? null)

  if (!res.ok && res.status === 404) {
    const errText = await res.text()
    if (errText.includes('Session not found')) {
      onSessionNotFound?.()
      res = await postChat(null)
    } else {
      onHttpError({ status: res.status, message: errText })
      return null
    }
  }

  if (!res.ok) {
    const errText = await res.text()
    let friendly = errText
    try {
      const parsed = JSON.parse(errText)
      if (parsed?.error) friendly = parsed.error
    } catch {
      /* not JSON */
    }
    onHttpError({
      status: res.status,
      message:
        res.status === 409 ? friendly : `HTTP ${res.status}: ${friendly}`,
    })
    return null
  }

  const meta = {
    sessionId: res.headers.get('x-session-id'),
    runId: res.headers.get('x-run-id'),
    lastSeq: 0,
    permissionMode: res.headers.get('x-permission-mode'),
    // Distinguish "header absent" from "header empty" (clear agent type).
    agentType: res.headers.has('x-agent-type')
      ? res.headers.get('x-agent-type')
      : undefined,
  }
  onOpen?.(meta)

  if (!res.body) {
    onHttpError({ status: res.status, message: 'Empty response body' })
    return null
  }

  let terminal = false
  const consume = async response => {
    if (!response.body) throw new Error('Empty response body')
    for await (const data of parseSSE(response.body, signal)) {
      if (!data || typeof data !== 'object' || !data.type) continue
      if (data.type === 'unknown') continue
      const seq = Number.parseInt(data.__eventId ?? '', 10)
      if (Number.isFinite(seq)) {
        if (seq <= meta.lastSeq) continue
        meta.lastSeq = seq
      }
      if (data.type === 'result') terminal = true
      try {
        onEvent(data)
      } catch (e) {
        console.error('[SSE] handler error:', data.type, e)
      }
    }
  }

  try {
    await consume(res)
  } catch (err) {
    if (signal.aborted || err?.name === 'AbortError') throw err
    if (!meta.runId) throw err
  }

  if (meta.runId && !terminal && !signal.aborted) {
    await reconnectRunStream({
      meta,
      signal,
      onEvent,
      onReconnecting,
      onTerminal: () => {
        terminal = true
      },
    })
  }
  return meta
}

/**
 * Resume an already-created durable run (page refresh / network reconnect).
 * @param {{
 *   runId: string,
 *   afterSeq?: number,
 *   signal: AbortSignal,
 *   onEvent: (data: object) => void,
 *   onReconnecting?: (meta: ChatStreamMeta) => void,
 * }} opts
 */
export async function streamDurableRun({
  runId,
  afterSeq = 0,
  signal,
  onEvent,
  onReconnecting,
}) {
  const meta = {
    sessionId: null,
    runId,
    lastSeq: afterSeq,
    permissionMode: null,
    agentType: undefined,
  }
  await reconnectRunStream({
    meta,
    signal,
    onEvent,
    onReconnecting,
    onTerminal: () => {},
    immediate: true,
  })
  return meta
}

async function reconnectRunStream({
  meta,
  signal,
  onEvent,
  onReconnecting,
  onTerminal,
  immediate = false,
}) {
  let delay = immediate ? 0 : 500
  while (!signal.aborted && meta.runId) {
    if (delay > 0) {
      onReconnecting?.(meta)
      await wait(delay, signal)
    }

    let response
    try {
      response = await agentApi.streamRun(meta.runId, meta.lastSeq, signal)
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`)
        err.status = response.status
        throw err
      }
      if (!response.body) throw new Error('Empty response body')
      for await (const data of parseSSE(response.body, signal)) {
        if (!data || typeof data !== 'object' || !data.type) continue
        if (data.type === 'unknown') continue
        const seq = Number.parseInt(data.__eventId ?? '', 10)
        if (Number.isFinite(seq)) {
          if (seq <= meta.lastSeq) continue
          meta.lastSeq = seq
        }
        onEvent(data)
        if (data.type === 'result') {
          onTerminal()
          return
        }
      }
      const state = await agentApi.getRun(meta.runId)
      if (
        ['finished', 'error', 'cancelled', 'interrupted'].includes(state.status)
      ) {
        if (state.status === 'error') {
          onEvent({
            type: 'result',
            subtype: 'error',
            error: state.error || 'Run failed',
            session_id: state.sessionId,
          })
        } else if (
          state.status === 'cancelled' ||
          state.status === 'interrupted'
        ) {
          onEvent({
            type: 'system',
            subtype: 'interrupted',
            text: state.finalText,
            session_id: state.sessionId,
          })
        } else {
          onEvent({
            type: 'result',
            subtype: 'success',
            reason: state.reason || 'done',
            text: state.finalText,
            session_id: state.sessionId,
          })
        }
        onTerminal()
        return
      }
      delay = 500
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError') throw err
      if ([401, 403, 404].includes(err?.status)) throw err
      delay = Math.min(Math.max(delay || 500, 500) * 2, 15_000)
    }
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Open GET /sessions/:id/live and yield protocol messages until aborted.
 *
 * @param {{
 *   sessionId: string,
 *   signal: AbortSignal,
 *   onEvent: (data: object) => void,
 * }} opts
 */
export async function streamSessionLive({ sessionId, signal, onEvent }) {
  const res = await agentApi.streamSessionLive(sessionId, signal)
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  if (!res.body) {
    const err = new Error('Empty response body')
    err.status = res.status
    throw err
  }
  for await (const data of parseSSE(res.body, signal)) {
    if (!data || typeof data !== 'object' || !data.type) continue
    if (data.type === 'unknown' || data.type === 'keep_alive') continue
    try {
      onEvent(data)
    } catch (e) {
      console.error('[SSE live] handler error:', data.type, e)
    }
  }
}
