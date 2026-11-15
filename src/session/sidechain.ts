/**
 * Subagent transcripts ("sidechains"): one JSONL per subagent run under the
 * session's data directory, written message by message as the subagent works,
 * so a finished subagent can be continued with its full context.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Message } from '../core/types.js'
import { isAttachmentMessage } from '../core/types.js'
import { getSessionDataDir } from '../core/session-paths.js'
import {
  parseSessionJsonLine,
  stringifySessionJsonLine,
} from './json-serialize.js'
import { projectMessageForDisk } from './persist-project.js'
import { replayTranscriptMessages } from './compact-replay.js'

export interface SidechainMeta {
  agentId: string
  agentType: string
  description: string
  createdAt: number
  /** The git worktree the agent works in (`isolation: worktree`). */
  worktree?: import('../utils/worktree.js').AgentWorktree
}

const AGENT_ID = /^[A-Za-z0-9_-]+$/
/** Last row written per sidechain file: the next row's parent. */
const tips = new Map<string, string | null>()

function filePaths(
  sessionId: string,
  agentId: string,
): { transcript: string; meta: string } | null {
  if (!AGENT_ID.test(agentId)) return null
  let dir: string
  try {
    dir = path.join(getSessionDataDir(sessionId), 'subagents')
  } catch {
    return null
  }
  return {
    transcript: path.join(dir, `agent-${agentId}.jsonl`),
    meta: path.join(dir, `agent-${agentId}.meta.json`),
  }
}

export function writeSidechainMeta(
  sessionId: string,
  meta: SidechainMeta,
): void {
  const paths = filePaths(sessionId, meta.agentId)
  if (!paths) return
  fs.mkdirSync(path.dirname(paths.meta), { recursive: true })
  fs.writeFileSync(paths.meta, JSON.stringify(meta))
}

export function appendSidechainMessage(
  sessionId: string,
  agentId: string,
  message: Message,
): void {
  const paths = filePaths(sessionId, agentId)
  if (!paths) return
  const parentUuid = tips.get(paths.transcript) ?? null
  if (message.uuid) tips.set(paths.transcript, message.uuid)
  const row = isAttachmentMessage(message)
    ? { ...message, parentUuid }
    : { type: 'message', ...projectMessageForDisk(message), parentUuid }
  fs.mkdirSync(path.dirname(paths.transcript), { recursive: true })
  fs.appendFileSync(
    paths.transcript,
    stringifySessionJsonLine({ ...row, timestamp: Date.now() }) + '\n',
  )
}

/** The subagent's metadata and messages, or null when it left no transcript. */
export function readSidechain(
  sessionId: string,
  agentId: string,
): { meta: SidechainMeta; messages: Message[] } | null {
  const paths = filePaths(sessionId, agentId)
  if (!paths || !fs.existsSync(paths.meta)) return null
  const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf-8')) as SidechainMeta
  const rows = fs.existsSync(paths.transcript)
    ? fs
        .readFileSync(paths.transcript, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .flatMap(line => {
          try {
            return [parseSessionJsonLine(line)]
          } catch {
            return []
          }
        })
    : []
  const { messages, leafUuid } = replayTranscriptMessages(rows)
  tips.set(paths.transcript, leafUuid)
  return { meta, messages }
}
