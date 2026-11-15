/**
 * Rewind a conversation to before one of the user's messages (optionally
 * putting the files back too), or fork a new session from that point.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Message, Session } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import { isUserQueuedMessage } from '../utils/attachments/queued-commands.js'
import { getCachedSessionLocation } from './paths.js'
import {
  fileHistoryCanRestore,
  fileHistoryChangedFiles,
  fileHistoryCopy,
  fileHistoryCreatedFiles,
  fileHistoryRewind,
  type RewindResult,
} from '../utils/fileHistory.js'
import {
  appendMessage,
  appendModeChange,
  appendRewind,
  createSession,
  getSessionDataDirFor,
  resyncDerivedSessionState,
  sessionModeAsOf,
  setSessionTitle,
  setSessionWorkspace,
} from './store.js'

export class RewindError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message)
  }
}

/**
 * What the user typed: the message that opened a turn, or one sent while a
 * turn ran and handed to the model between two tool rounds.
 */
function isUserTyped(message: Message): boolean {
  return (
    isUserQueuedMessage(message) ||
    (isRoleMessage(message) && message.role === 'user' && !message.isMeta)
  )
}

function userMessageIndex(session: Session, messageUuid: string): number {
  const index = session.messages.findIndex(m => m.uuid === messageUuid)
  const message = session.messages[index]
  if (!message || !isUserTyped(message)) {
    throw new RewindError('No such user message in this conversation', 404)
  }
  return index
}

export function messageText(message: Message): string {
  if (isUserQueuedMessage(message)) return message.attachment.prompt
  if (!isRoleMessage(message)) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content as Array<{ type: string; text?: string }>)
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

export interface RewindPreview {
  canRestoreFiles: boolean
  changedFiles: string[]
  /** Those of `changedFiles` a restore deletes: they did not exist then. */
  createdFiles: string[]
}

export function previewRewind(
  session: Session,
  messageUuid: string,
): RewindPreview {
  userMessageIndex(session, messageUuid)
  return {
    canRestoreFiles: fileHistoryCanRestore(session.id, messageUuid),
    changedFiles: fileHistoryChangedFiles(session.id, messageUuid),
    createdFiles: fileHistoryCreatedFiles(session.id, messageUuid),
  }
}

/**
 * Drop `messageUuid` and everything after it, and go back to the mode the
 * message was sent in. Returns the message's text, for the caller to offer
 * back for editing.
 */
export function rewindSession(
  session: Session,
  messageUuid: string,
  opts: { restoreFiles?: boolean } = {},
): { prompt: string; files: RewindResult | null } {
  const index = userMessageIndex(session, messageUuid)
  const prompt = messageText(session.messages[index]!)
  let files: RewindResult | null = null
  if (opts.restoreFiles) {
    if (!fileHistoryCanRestore(session.id, messageUuid)) {
      throw new RewindError('No file snapshot for this message', 409)
    }
    files = fileHistoryRewind(session.id, messageUuid)
  }
  const mode = sessionModeAsOf(session.id, messageUuid)
  const leafUuid = session.messages[index - 1]?.uuid ?? null
  session.messages.splice(index)
  appendRewind(session.id, leafUuid)
  resyncDerivedSessionState(session)
  if (mode) {
    Object.assign(session, mode)
    appendModeChange(session.id, session)
  }
  return { prompt, files }
}

/**
 * A new session holding the conversation before `messageUuid`, in the same
 * workspace and the mode that message was sent in. The files on disk are
 * shared and left as they are.
 *
 * The fork has the source's owner, home and workspace, so only the owner may
 * fork; the route refuses everyone else.
 */
export function forkSession(
  source: Session,
  messageUuid: string,
): { session: Session; prompt: string } {
  const index = userMessageIndex(source, messageUuid)
  const location = getCachedSessionLocation(source.id)
  const fork = createSession({
    ownerEmail: source.ownerEmail,
    agentHome: location?.agentHome,
  })
  if (source.workspace) setSessionWorkspace(fork.id, source.workspace)

  // Spilled tool results and uploads the copied messages point at.
  const from = getSessionDataDirFor(source.id)
  const to = getSessionDataDirFor(fork.id)
  if (fs.existsSync(from)) {
    fs.cpSync(from, to, {
      recursive: true,
      filter: src => path.basename(src) !== 'file-history',
    })
  }
  fileHistoryCopy(source.id, fork.id, messageUuid)

  for (const message of source.messages.slice(0, index)) {
    const copy = structuredClone(message)
    fork.messages.push(copy)
    appendMessage(fork.id, copy)
  }
  Object.assign(
    fork,
    sessionModeAsOf(source.id, messageUuid) ?? {
      permissionMode: structuredClone(source.permissionMode),
      agentType: source.agentType ?? null,
    },
  )
  appendModeChange(fork.id, fork)
  setSessionTitle(fork.id, `${source.title?.trim() || 'Session'} (fork)`)
  return { session: fork, prompt: messageText(source.messages[index]!) }
}
