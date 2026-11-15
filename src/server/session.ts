/**
 * HTTP-facing session helpers. Persistence lives in `src/session/`;
 * access control stays here because it depends on server auth.
 */
import type { Session } from '../core/types.js'
import { isSuperRole } from './auth/identity.js'
import { isAuthEnabled } from '../utils/env.js'

export {
  getToolResultFilePath,
  tryBeginTurn,
  endTurn,
  listActiveTurnSessionIds,
  getActiveTurnAgentHome,
  createSession,
  getSession,
  setSessionTitle,
  setSessionWorkspace,
  listSessions,
  deleteSession,
  forgetSession,
  appendMessage,
  appendCompaction,
  appendModeChange,
  appendAgentChange,
  getSessionTranscriptPath,
} from '../session/index.js'

/**
 * Whether `requesterEmail` may read `session`.
 *
 * - Auth off (legacy / local / password mode): always true.
 * - Auth on: the requester must match the session's recorded owner, unless
 *   their JWT role is `super` (may read any session). Sessions with no owner
 *   are denied to non-super users so UUID guessing cannot leak history.
 */
export function canAccessSession(
  session: Session,
  requesterEmail: string | undefined,
  requesterRole?: string,
): boolean {
  if (!isAuthEnabled()) return true
  if (isSuperRole(requesterRole)) return true
  return Boolean(requesterEmail) && session.ownerEmail === requesterEmail
}

/**
 * Whether the requester may change or delete `session`.
 *
 * Super may view any session ({@link canAccessSession}) but may only mutate
 * their own — same rule as DELETE /sessions/:id.
 */
export function canMutateSession(
  session: Session,
  requesterEmail: string | undefined,
  requesterRole?: string,
): boolean {
  if (!canAccessSession(session, requesterEmail, requesterRole)) return false
  if (!isAuthEnabled()) return true
  if (
    isSuperRole(requesterRole) &&
    session.ownerEmail &&
    session.ownerEmail !== requesterEmail
  ) {
    return false
  }
  return true
}
