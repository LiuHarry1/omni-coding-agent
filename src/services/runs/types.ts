import type { OutgoingMessage } from '../../../protocol/src/wire.js'
import type { ChatAttachmentRef } from '../../utils/attachments/from-chat-upload.js'

export type DurableRunStatus =
  | 'creating'
  | 'running'
  | 'requires_action'
  | 'waiting_for_background_work'
  | 'recovering'
  | 'finished'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface DurableRunState {
  version: 1
  runId: string
  sessionId: string
  status: DurableRunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  /** Persisted cancellation intent; terminal status is written after execution settles. */
  cancelRequestedAt?: number
  attempt: number
  ownerEmail?: string
  ownerRole?: string
  agentHome: string
  cwd: string
  mode?: string
  agentType?: string | null
  openingMessageUuid?: string
  lastMessageUuid?: string
  /** Latest event emitted by the live run. Recovered from events.jsonl on load. */
  lastSeq: number
  /** Events through this sequence are represented by the durable transcript. */
  checkpointSeq: number
  finalText?: string
  reason?: string
  error?: string
  /** Original accepted input, used only if the process dies before seeding it. */
  requestPayload?: {
    message: string
    images?: string[]
    attachments?: ChatAttachmentRef[]
  }
}

export interface StoredRunEvent {
  version: 1
  runId: string
  seq: number
  timestamp: number
  event: OutgoingMessage
}

export interface CreateDurableRunInput {
  sessionId: string
  ownerEmail?: string
  ownerRole?: string
  agentHome: string
  cwd: string
  mode?: string
  agentType?: string | null
  requestPayload?: DurableRunState['requestPayload']
}

export function isTerminalRunStatus(status: DurableRunStatus): boolean {
  return (
    status === 'finished' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}
