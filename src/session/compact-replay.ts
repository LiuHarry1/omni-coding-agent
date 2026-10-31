import { randomUUID } from 'node:crypto'
import type { Message, ToolResultPart } from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from '../core/messages/compact-boundary.js'
import { reviveBuffersInMessages } from './json-serialize.js'

type JsonlRow = Record<string, unknown>

export type MessageUuidMigration = {
  eventIndex: number
  uuid: string
}

function messageFromLine(line: JsonlRow): Message {
  const {
    type: _,
    timestamp: __,
    messageType,
    messageTimestamp,
    ...stored
  } = line
  const message =
    messageType === 'system'
      ? { type: 'system', ...stored, timestamp: messageTimestamp }
      : stored
  return reviveBuffersInMessages([message as unknown as Message])[0]!
}

function attachmentFromLine(line: JsonlRow): Message {
  const { timestamp, messageTimestamp, ...stored } = line
  return reviveBuffersInMessages([
    {
      ...stored,
      timestamp:
        typeof messageTimestamp === 'string'
          ? messageTimestamp
          : new Date(
              typeof timestamp === 'number' ? timestamp : Date.now(),
            ).toISOString(),
    } as unknown as Message,
  ])[0]!
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === 'uuid' || key === 'timestamp' || key === 'usage') continue
    output[key] = stableValue((value as Record<string, unknown>)[key])
  }
  return output
}

/** Stable across usage/timestamp enrichment and JSON property ordering. */
export function compactReplayFingerprint(message: Message): string {
  return JSON.stringify(stableValue(message))
}

function isCompactSummary(message: Message): boolean {
  return (
    isRoleMessage(message) &&
    message.role === 'user' &&
    (message.isCompactSummary === true ||
      (typeof message.content === 'string' &&
        message.content.startsWith(
          '[Previous conversation compacted — context continues below]',
        )))
  )
}

function findLegacyMatch(
  candidates: readonly Message[],
  snapshot: Message,
  used: Set<Message>,
): Message | undefined {
  if (snapshot.uuid) {
    const byUuid = candidates.find(
      message => !used.has(message) && message.uuid === snapshot.uuid,
    )
    if (byUuid) return byUuid
  }
  const fingerprint = compactReplayFingerprint(snapshot)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!
    if (
      !used.has(candidate) &&
      compactReplayFingerprint(candidate) === fingerprint
    ) {
      return candidate
    }
  }
  return undefined
}

/**
 * Convert a legacy active-snapshot checkpoint to append-only in-memory events.
 * Every role/tool snapshot entry is retained: matching originals are reused,
 * while entries missing from old JSONL are inserted immediately pre-boundary.
 */
export function replayLegacyCompaction(history: Message[], raw: unknown): void {
  if (!Array.isArray(raw)) return
  const snapshot = reviveBuffersInMessages(raw as Message[])
  const summary = snapshot.find(isCompactSummary)
  if (summary && !summary.uuid) summary.uuid = randomUUID()

  const tail = snapshot.filter(
    message =>
      message !== summary &&
      !isAttachmentMessage(message) &&
      !isCompactBoundaryMessage(message),
  )
  const active = getMessagesAfterCompactBoundary(history)
  const used = new Set<Message>()
  const preserved: Message[] = []
  for (const snapshotMessage of tail) {
    let match = findLegacyMatch(active, snapshotMessage, used)
    if (!match) match = findLegacyMatch(history, snapshotMessage, used)
    if (match) {
      used.add(match)
      if (!match.uuid) match.uuid = snapshotMessage.uuid ?? randomUUID()
      preserved.push(match)
    } else {
      if (!snapshotMessage.uuid) snapshotMessage.uuid = randomUUID()
      history.push(snapshotMessage)
      preserved.push(snapshotMessage)
    }
  }

  const previous = history.at(-1)
  const boundary = createCompactBoundaryMessage(
    'auto',
    0,
    previous?.uuid,
    undefined,
    Math.max(0, active.length - tail.length),
  )
  if (summary?.uuid && preserved.length > 0) {
    boundary.compactMetadata.preservedSegment = {
      headUuid: preserved[0]!.uuid!,
      anchorUuid: summary.uuid,
      tailUuid: preserved.at(-1)!.uuid!,
      preservedUuids: preserved.map(message => message.uuid!),
    }
  }
  history.push(boundary)
  if (summary) history.push(summary)

  const seen = new Set(history.map(message => message.uuid).filter(Boolean))
  for (const attachment of snapshot.filter(isAttachmentMessage)) {
    if (!attachment.uuid) attachment.uuid = randomUUID()
    if (seen.has(attachment.uuid)) continue
    history.push(attachment)
    seen.add(attachment.uuid)
  }
}

/**
 * Shared store/UI transcript replay. Missing UUIDs are restored from
 * append-only migration rows, or assigned once and returned for persistence.
 */
export function replayTranscriptMessages(lines: readonly JsonlRow[]): {
  messages: Message[]
  migrations: MessageUuidMigration[]
} {
  const existingMigrations = new Map<number, string>()
  for (const line of lines) {
    if (
      line.type === 'message_uuid_migrated' &&
      typeof line.eventIndex === 'number' &&
      typeof line.uuid === 'string'
    ) {
      existingMigrations.set(line.eventIndex, line.uuid)
    }
  }

  const messages: Message[] = []
  const migrations: MessageUuidMigration[] = []
  let eventIndex = 0
  for (const line of lines) {
    let message: Message | undefined
    if (line.type === 'message') message = messageFromLine(line)
    else if (line.type === 'attachment') message = attachmentFromLine(line)
    else if (line.type === 'compacted') {
      replayLegacyCompaction(messages, line.messages)
      continue
    } else {
      continue
    }

    if (!message.uuid) {
      const migrated = existingMigrations.get(eventIndex)
      message.uuid = migrated ?? randomUUID()
      if (!migrated) migrations.push({ eventIndex, uuid: message.uuid })
    }
    messages.push(message)
    eventIndex++
  }

  const byUuid = new Map(
    messages
      .filter(message => typeof message.uuid === 'string')
      .map(message => [message.uuid!, message]),
  )
  for (const line of lines) {
    if (
      line.type !== 'turn_timing' ||
      typeof line.messageUuid !== 'string' ||
      typeof line.startTime !== 'number' ||
      typeof line.endTime !== 'number'
    ) {
      continue
    }
    const message = byUuid.get(line.messageUuid)
    if (!message || !isRoleMessage(message) || message.role !== 'user') continue
    message.turnStartTime = line.startTime
    message.turnEndTime = line.endTime
  }

  for (const line of lines) {
    if (
      line.type !== 'tool_outcome_unknown' ||
      typeof line.assistantMessageUuid !== 'string' ||
      typeof line.toolMessageUuid !== 'string' ||
      !Array.isArray(line.results)
    ) {
      continue
    }
    const assistantIndex = messages.findIndex(
      message => message.uuid === line.assistantMessageUuid,
    )
    if (assistantIndex < 0) continue
    const results = line.results.filter(
      (part): part is ToolResultPart =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'tool-result' &&
        typeof (part as { toolCallId?: unknown }).toolCallId === 'string',
    )
    if (results.length === 0) continue
    const next = messages[assistantIndex + 1]
    if (next && isRoleMessage(next) && next.role === 'tool') {
      const existing = new Set(
        next.content
          .filter(part => part.type === 'tool-result')
          .map(part => part.toolCallId),
      )
      next.content.push(
        ...results.filter(part => !existing.has(part.toolCallId)),
      )
    } else {
      messages.splice(assistantIndex + 1, 0, {
        role: 'tool',
        uuid: line.toolMessageUuid,
        content: results,
      })
    }
  }
  return { messages, migrations }
}
