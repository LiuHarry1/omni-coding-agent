/**
 * Messages sent while a turn is running.
 *
 *   GET    /sessions/:id/queue        -- the user's messages still queued
 *   POST   /sessions/:id/queue        -- queue a message for the running turn
 *   DELETE /sessions/:id/queue/:uuid  -- take a queued message back
 *
 * The running turn picks a queued message up after its next tool round and
 * reports it with a `queued_command` event. A message the turn does not get
 * to is dropped when the turn ends; the sender, who has seen no such event,
 * sends it as an ordinary turn then. With no turn running there is nothing
 * to queue for, and POST answers 409.
 */
import { randomUUID } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { AuthedRequest } from '../auth/identity.js'
import { readBody, sendJSON } from '../http.js'
import { canAccessSession, getSession } from '../session.js'
import { isTurnActive } from '../../session/store.js'
import {
  enqueue,
  getCommandQueue,
  removeByFilter,
  type QueuedCommand,
} from '../../utils/messageQueueManager.js'

/** Most messages one session may have waiting at a time. */
export const MAX_QUEUED_PROMPTS = 20

const isUserPrompt = (cmd: QueuedCommand): boolean =>
  cmd.mode === 'prompt' && cmd.agentId === undefined && !cmd.isMeta

function queuedPrompts(
  sessionId: string,
): Array<{ id: string; message: string }> {
  return getCommandQueue(sessionId)
    .filter(isUserPrompt)
    .map(cmd => ({ id: cmd.uuid ?? '', message: cmd.value }))
}

export async function handleSessionQueue(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0]!
  const match = pathname.match(/^\/sessions\/([^/]+)\/queue(?:\/([^/]+))?$/)
  if (!match) return false
  const method = req.method
  const commandId = match[2] ? decodeURIComponent(match[2]) : undefined
  if (commandId ? method !== 'DELETE' : method !== 'GET' && method !== 'POST') {
    return false
  }

  const sessionId = decodeURIComponent(match[1]!)
  const authed = req as AuthedRequest
  const session = getSession(sessionId)
  if (
    !session ||
    !canAccessSession(session, authed.user?.email, authed.user?.role)
  ) {
    sendJSON(res, 404, { error: 'Session not found' })
    return true
  }

  if (method === 'GET') {
    sendJSON(res, 200, {
      turn_active: isTurnActive(sessionId),
      queued: queuedPrompts(sessionId),
    })
    return true
  }

  if (method === 'DELETE') {
    const removed = removeByFilter(
      sessionId,
      cmd => isUserPrompt(cmd) && cmd.uuid === commandId,
    )
    // Not there any more: the turn took it, or it ended.
    sendJSON(res, 200, { removed: removed.length > 0 })
    return true
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch (err) {
    sendJSON(res, 400, { error: (err as Error).message })
    return true
  }
  const message = typeof body.message === 'string' ? body.message : ''
  if (!message.trim()) {
    sendJSON(res, 400, { error: "Missing 'message'" })
    return true
  }
  const id =
    typeof body.id === 'string' && body.id.trim() ? body.id : randomUUID()

  // Checked and queued without an await in between: a turn that is running
  // now will see the message or drop it at its end, never neither.
  if (!isTurnActive(sessionId)) {
    sendJSON(res, 409, {
      queued: false,
      error:
        'No turn is running for this session. Send the message as a chat request.',
    })
    return true
  }
  const waiting = queuedPrompts(sessionId)
  if (waiting.some(entry => entry.id === id)) {
    sendJSON(res, 202, { queued: true, id })
    return true
  }
  if (waiting.length >= MAX_QUEUED_PROMPTS) {
    sendJSON(res, 429, {
      queued: false,
      error: `Too many queued messages (limit ${MAX_QUEUED_PROMPTS}).`,
    })
    return true
  }
  enqueue(sessionId, { value: message, mode: 'prompt', uuid: id })
  sendJSON(res, 202, { queued: true, id })
  return true
}
