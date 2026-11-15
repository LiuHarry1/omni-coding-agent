/**
 * Going back in a conversation.
 *
 *   GET  /sessions/:id/rewind/:messageId  -- what rewinding there would restore
 *   POST /sessions/:id/rewind  { message_id, restore_files? }
 *        -- drop that user message and everything after it, and return to
 *           the mode it was sent in
 *   POST /sessions/:id/fork    { message_id }
 *        -- a new session with the conversation before that message
 *
 * Both POSTs answer with the dropped message's text so the client can put it
 * back in the input. Neither runs while a turn is (409). Both are the
 * owner's alone (403): a super user may look at another user's session, not
 * rewind it, nor fork it into that user's home and workspace.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { AuthedRequest } from '../auth/identity.js'
import { readBody, sendJSON } from '../http.js'
import { canAccessSession, canMutateSession, getSession } from '../session.js'
import { isTurnActive } from '../../session/store.js'
import {
  RewindError,
  forkSession,
  previewRewind,
  rewindSession,
} from '../../session/rewind.js'
import { sessionJsonlToUIMessages } from '../session-ui.js'

export async function handleSessionRewind(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0]!
  const match = pathname.match(
    /^\/sessions\/([^/]+)\/(rewind|fork)(?:\/([^/]+))?$/,
  )
  if (!match) return false
  const action = match[2]!
  const messageParam = match[3] ? decodeURIComponent(match[3]) : undefined
  const method = req.method
  const preview = action === 'rewind' && method === 'GET' && !!messageParam
  if (!preview && (method !== 'POST' || messageParam)) return false

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

  try {
    if (preview) {
      const result = previewRewind(session, messageParam!)
      sendJSON(res, 200, {
        can_restore_files: result.canRestoreFiles,
        changed_files: result.changedFiles,
        created_files: result.createdFiles,
      })
      return true
    }

    if (!canMutateSession(session, authed.user?.email, authed.user?.role)) {
      sendJSON(res, 403, { error: "Cannot modify another user's session" })
      return true
    }
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' })
      return true
    }
    if (typeof body.message_id !== 'string' || !body.message_id) {
      sendJSON(res, 400, { error: 'message_id is required' })
      return true
    }
    if (isTurnActive(sessionId)) {
      sendJSON(res, 409, { error: 'Stop the running turn first' })
      return true
    }

    if (action === 'fork') {
      const fork = forkSession(session, body.message_id)
      sendJSON(res, 200, { session_id: fork.session.id, prompt: fork.prompt })
      return true
    }
    const result = rewindSession(session, body.message_id, {
      restoreFiles: body.restore_files === true,
    })
    sendJSON(res, 200, {
      prompt: result.prompt,
      files: result.files,
      mode: session.permissionMode.mode,
      agent_type: session.agentType ?? null,
      messages: sessionJsonlToUIMessages(sessionId),
    })
  } catch (err) {
    if (err instanceof RewindError) {
      sendJSON(res, err.status, { error: err.message })
    } else {
      sendJSON(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return true
}
