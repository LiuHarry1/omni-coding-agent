/**
 * A subagent's own conversation.
 *
 *   GET /sessions/:id/subagents/:agentId
 *       -- what the subagent was asked, said and did, in the shape the
 *          session's own messages are served in
 *
 * The parent conversation only carries the subagent's report and a capped
 * list of its tool steps; this is the whole transcript, as it stands on
 * disk -- complete once the agent is done, up to its last finished message
 * while it runs. Readable by whoever may read the session.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { AuthedRequest } from '../auth/identity.js'
import { sendJSON } from '../http.js'
import { canAccessSession, getSession } from '../session.js'
import { readSidechain } from '../../session/sidechain.js'
import { sessionToUIMessages } from '../session-ui.js'

export function handleSessionSubagents(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== 'GET') return false
  const pathname = (req.url ?? '').split('?')[0]!
  const match = pathname.match(/^\/sessions\/([^/]+)\/subagents\/([^/]+)$/)
  if (!match) return false

  let sessionId: string
  let agentId: string
  try {
    sessionId = decodeURIComponent(match[1]!)
    agentId = decodeURIComponent(match[2]!)
  } catch {
    sendJSON(res, 404, { error: 'Subagent not found' })
    return true
  }
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
    // An id that is not an agent id names no file: readSidechain answers
    // null for it, as for an agent that left no transcript.
    const sidechain = readSidechain(sessionId, agentId, { view: true })
    if (!sidechain) {
      sendJSON(res, 404, { error: 'Subagent not found' })
      return true
    }
    sendJSON(res, 200, {
      agent: {
        agent_id: sidechain.meta.agentId,
        agent_type: sidechain.meta.agentType,
        description: sidechain.meta.description,
        created_at: sidechain.meta.createdAt,
        ...(sidechain.meta.model ? { model: sidechain.meta.model } : {}),
      },
      messages: sessionToUIMessages(sidechain.messages),
    })
  } catch (err) {
    sendJSON(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return true
}
