/**
 * Micro-compaction: cheap, no-LLM pass that clears old tool payloads.
 *
 * For read-oriented tools (bash, grep, read_file, ...) clears the OUTPUT.
 * For write-oriented tools (write_file, edit_file, ...) clears the INPUT.
 * Tool blocks are preserved (only payloads replaced) so tool_call ↔
 * tool_result pairing stays intact.
 *
 * When Read results are cleared, matching entries are dropped from
 * `readFileState` so file_unchanged dedup cannot stub against cleared content.
 */
import * as fs from 'fs'
import * as path from 'path'
import type {
  AssistantMessage,
  Message,
  ToolMessage,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import type { ReadFileState } from '../../utils/read/types.js'
import { invalidateReadPaths } from '../../utils/read/read-file-state.js'
import { resolveFileInCwd } from '../../utils/read/index.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  BROWSER_TOOL_NAMES,
} from '../../constants/tool_names.js'
import { estimateMessageTokens } from './tokens.js'
import {
  bytesPerTokenForToolResult,
  roughTokenCountEstimation,
} from '../tokenEstimation.js'
import {
  isPersistedReference,
  offloadReferenceForCompact,
  relocatePersistedReference,
} from '../tool-storage/index.js'
import { toolResultOutputToText } from '../../utils/tool-result-content.js'
import {
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
} from '../../core/messages/compact-boundary.js'
import {
  getCachedSessionLocation,
  getToolResultFilePath,
  sessionDataDir,
} from '../../core/session-paths.js'

const MICRO_COMPACT_MARKER = '[Old tool result content cleared to save context]'

const MICRO_COMPACT_INPUT_MARKER = {
  _cleared: true,
  note: 'Old tool input cleared to save context',
}

const CLEARABLE_TOOL_RESULTS = new Set<string>([
  BASH_TOOL_NAME,
  'shell',
  POWERSHELL_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  // Browser YAML snapshots fill the window in a few dozen clicks; drop old
  // ones in micro-compact so fill loops do not full-LLM-compact every minute.
  ...BROWSER_TOOL_NAMES,
])

const CLEARABLE_TOOL_INPUTS = new Set<string>([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  'create_file',
  'apply_patch',
  'NotebookEdit',
])

const CLEARABLE_MIN_CHARS = 2_000

const MARKER_INPUT_JSON = JSON.stringify(MICRO_COMPACT_INPUT_MARKER)
const MARKER_INPUT_COST = roughTokenCountEstimation(MARKER_INPUT_JSON)

export interface MicroCompactResult {
  messages: Message[]
  tokensFreed: number
  cleared: number
  /** Absolute paths whose Read results were cleared (for readFileState sync). */
  clearedReadAbsPaths: string[]
}

type ClearedToolResult = {
  messageUuid: string
  toolCallId: string
  replacement: string
}

type ClearedToolInput = {
  messageUuid: string
  toolCallId: string
}

type MicroCompactState = {
  boundaryUuid?: string
  results: Map<string, ClearedToolResult>
  inputs: Map<string, ClearedToolInput>
}

const sessionMicroCompactState = new Map<string, MicroCompactState>()
/** Sessions whose on-disk projection has already been read this process. */
const loadedFromDisk = new Set<string>()

const STATE_FILE_NAME = 'micro-compact.json'
const STATE_FILE_VERSION = 1

type PersistedMicroCompactState = {
  version: number
  boundaryUuid?: string
  results: ClearedToolResult[]
  inputs: ClearedToolInput[]
}

function currentBoundaryUuid(messages: readonly Message[]): string | undefined {
  const index = findLastCompactBoundaryIndex(messages)
  return index >= 0 ? messages[index]!.uuid : undefined
}

function stateKey(messageUuid: string, toolCallId: string): string {
  return `${messageUuid}\0${toolCallId}`
}

function stateFilePath(sessionId: string): string | undefined {
  const loc = getCachedSessionLocation(sessionId)
  return loc
    ? path.join(sessionDataDir(loc, sessionId), STATE_FILE_NAME)
    : undefined
}

/**
 * The real-usage token baseline is measured on the projected view, so losing
 * the projection on restart would send raw payloads while the estimate still
 * reports the small projected size. Persist it next to the transcript.
 */
function persistState(sessionId: string): void {
  const filePath = stateFilePath(sessionId)
  if (!filePath) return
  const state = sessionMicroCompactState.get(sessionId)
  let tempPath: string | undefined
  try {
    if (!state) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      return
    }
    const data: PersistedMicroCompactState = {
      version: STATE_FILE_VERSION,
      boundaryUuid: state.boundaryUuid,
      results: [...state.results.values()],
      inputs: [...state.inputs.values()],
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(data), {
      encoding: 'utf-8',
      flag: 'wx',
    })
    fs.renameSync(tempPath, filePath)
    tempPath = undefined
  } catch (err) {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup; preserve the original state file.
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[compact] micro-compact state persist failed: ${msg}`)
  }
}

function loadState(sessionId: string): MicroCompactState | undefined {
  const cached = sessionMicroCompactState.get(sessionId)
  if (cached || loadedFromDisk.has(sessionId)) return cached
  const filePath = stateFilePath(sessionId)
  if (!filePath) return undefined
  try {
    if (!fs.existsSync(filePath)) {
      loadedFromDisk.add(sessionId)
      return undefined
    }
    const data = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as PersistedMicroCompactState
    if (data.version !== STATE_FILE_VERSION) {
      loadedFromDisk.add(sessionId)
      return undefined
    }
    const state: MicroCompactState = {
      boundaryUuid: data.boundaryUuid,
      results: new Map(
        (data.results ?? []).map(r => [
          stateKey(r.messageUuid, r.toolCallId),
          r,
        ]),
      ),
      inputs: new Map(
        (data.inputs ?? []).map(r => [
          stateKey(r.messageUuid, r.toolCallId),
          r,
        ]),
      ),
    }
    sessionMicroCompactState.set(sessionId, state)
    loadedFromDisk.add(sessionId)
    return state
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[compact] micro-compact state load failed: ${msg}`)
    return undefined
  }
}

function dropState(sessionId: string): void {
  sessionMicroCompactState.delete(sessionId)
  persistState(sessionId)
}

/**
 * Forget a session's in-process micro-compaction projection. The on-disk
 * copy is kept so the projection is reloaded on next use.
 */
export function resetMicroCompactState(sessionId?: string): void {
  if (!sessionId) return
  sessionMicroCompactState.delete(sessionId)
  loadedFromDisk.delete(sessionId)
}

/**
 * Move clears that belong to a preserved compact tail onto its new boundary.
 * Clears outside the tail are discarded with the summarized head.
 */
export function rebaseMicroCompactState(
  sessionId: string | undefined,
  preservedTail: readonly Message[],
  compactedMessages: readonly Message[],
): void {
  if (!sessionId) return
  const state = loadState(sessionId)
  if (!state) return
  if (preservedTail.length === 0) {
    dropState(sessionId)
    return
  }
  const kept = new Set(
    preservedTail.map(message => message.uuid).filter(Boolean) as string[],
  )
  for (const [key, value] of state.results) {
    if (!kept.has(value.messageUuid)) state.results.delete(key)
  }
  for (const [key, value] of state.inputs) {
    if (!kept.has(value.messageUuid)) state.inputs.delete(key)
  }
  state.boundaryUuid = currentBoundaryUuid(compactedMessages)
  if (state.results.size === 0 && state.inputs.size === 0) {
    dropState(sessionId)
    return
  }
  persistState(sessionId)
}

/**
 * Reapply prior micro-clears to a freshly reconstructed active model view.
 * A new compact boundary ends the projection lifetime.
 */
export function applyMicroCompactProjection(
  messages: Message[],
  sessionId?: string,
): Message[] {
  if (!sessionId) return messages
  const state = loadState(sessionId)
  if (!state) return messages
  if (state.boundaryUuid !== currentBoundaryUuid(messages)) {
    dropState(sessionId)
    return messages
  }

  let changed = false
  const projected = messages.map(message => {
    if (!isRoleMessage(message) || !message.uuid) return message
    if (message.role === 'tool') {
      let touched = false
      const content = message.content.map(part => {
        const cleared = state.results.get(
          stateKey(message.uuid!, part.toolCallId),
        )
        if (!cleared) return part
        touched = true
        const replacement = relocatePersistedReference(
          cleared.replacement,
          getToolResultFilePath(sessionId, part.toolCallId),
        )
        return {
          ...part,
          output: { type: 'text' as const, value: replacement },
        }
      })
      if (touched) {
        changed = true
        return { ...message, content } as ToolMessage
      }
    }
    if (message.role === 'assistant') {
      let touched = false
      const content = message.content.map(part => {
        if (
          part.type !== 'tool-call' ||
          !state.inputs.has(stateKey(message.uuid!, part.toolCallId))
        ) {
          return part
        }
        touched = true
        return { ...part, input: { ...MICRO_COMPACT_INPUT_MARKER } }
      })
      if (touched) {
        changed = true
        return { ...message, content } as AssistantMessage
      }
    }
    return message
  })
  return changed ? projected : messages
}

/** Canonical active model/lifecycle view: latest boundary plus micro clears. */
export function getActiveModelMessages(
  messages: readonly Message[],
  sessionId?: string,
): Message[] {
  return applyMicroCompactProjection(
    getMessagesAfterCompactBoundary(messages),
    sessionId,
  )
}

function collectReadAbsByToolCallId(
  messages: Message[],
  cwd?: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (!isRoleMessage(m) || m.role !== 'assistant') continue
    for (const part of m.content) {
      if (part.type !== 'tool-call') continue
      if (part.toolName !== FILE_READ_TOOL_NAME) continue
      const fp = part.input?.file_path
      if (typeof fp !== 'string' || !fp) continue
      if (cwd) {
        const resolved = resolveFileInCwd(cwd, fp)
        if (!('error' in resolved)) {
          map.set(part.toolCallId, resolved.abs)
          continue
        }
      }
      map.set(part.toolCallId, path.isAbsolute(fp) ? fp : path.resolve(fp))
    }
  }
  return map
}

function absFromToolUseResult(tur: unknown, cwd?: string): string | undefined {
  if (!tur || typeof tur !== 'object') return undefined
  const file = (tur as { file?: { filePath?: string } }).file
  const fp = file?.filePath
  if (typeof fp !== 'string' || !fp) return undefined
  if (cwd) {
    const resolved = resolveFileInCwd(cwd, fp)
    if (!('error' in resolved)) return resolved.abs
  }
  return path.isAbsolute(fp) ? fp : path.resolve(fp)
}

/**
 * Ordered ids of every tool payload micro-compaction is allowed to clear —
 * clearable results plus clearable write inputs.
 *
 * Granularity is one id per tool call, not one per tool message. A step that
 * issues four parallel Reads lands in a single `tool` message, so counting
 * messages would treat the whole batch as one recent item and never clear any
 * of it. Keeping the last N compactable tool ids avoids that.
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const m of messages) {
    if (!isRoleMessage(m)) continue
    if (m.role === 'tool') {
      for (const part of m.content) {
        const text = toolResultOutputToText(part.output)
        if (text === MICRO_COMPACT_MARKER || isPersistedReference(text))
          continue
        if (
          CLEARABLE_TOOL_RESULTS.has(part.toolName) ||
          text.length >= CLEARABLE_MIN_CHARS
        ) {
          ids.push(part.toolCallId)
        }
      }
      continue
    }
    if (m.role === 'assistant') {
      for (const part of m.content) {
        if (part.type !== 'tool-call') continue
        if (!CLEARABLE_TOOL_INPUTS.has(part.toolName)) continue
        if (JSON.stringify(part.input ?? {}) === MARKER_INPUT_JSON) continue
        if (!ids.includes(part.toolCallId)) ids.push(part.toolCallId)
      }
    }
  }
  return ids
}

export function microCompact(
  messages: Message[],
  keepRecent: number,
  sessionId?: string,
  opts?: { cwd?: string; readFileState?: ReadFileState },
): MicroCompactResult {
  const compactableIds = collectCompactableToolIds(messages)
  const keep = Math.max(0, keepRecent)
  if (compactableIds.length <= keep) {
    return { messages, tokensFreed: 0, cleared: 0, clearedReadAbsPaths: [] }
  }

  // `slice(-0)` returns the whole array, so keep 0 has to be spelled out as
  // "protect nothing" rather than falling through to slice.
  const keepSet = new Set(keep > 0 ? compactableIds.slice(-keep) : [])
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))
  const readAbsById = collectReadAbsByToolCallId(messages, opts?.cwd)
  const clearedReadAbsPaths = new Set<string>()

  let tokensFreed = 0
  let cleared = 0

  const out = messages.map(m => {
    if (!isRoleMessage(m)) return m
    if (m.role === 'tool')
      return clearToolResults(
        m,
        sessionId,
        () => cleared++,
        n => (tokensFreed += n),
        readAbsById,
        clearedReadAbsPaths,
        opts?.cwd,
        clearSet,
      )
    if (m.role === 'assistant')
      return clearToolInputs(
        m,
        () => cleared++,
        n => (tokensFreed += n),
        clearSet,
      )
    return m
  })

  if (clearedReadAbsPaths.size > 0) {
    invalidateReadPaths(opts?.readFileState, clearedReadAbsPaths)
  }

  if (sessionId && cleared > 0) {
    rememberMicroCompactProjection(sessionId, messages, out)
  }

  return {
    messages: out,
    tokensFreed,
    cleared,
    clearedReadAbsPaths: [...clearedReadAbsPaths],
  }
}

function rememberMicroCompactProjection(
  sessionId: string,
  original: Message[],
  projected: Message[],
): void {
  const boundaryUuid = currentBoundaryUuid(original)
  let state = loadState(sessionId)
  if (!state || state.boundaryUuid !== boundaryUuid) {
    state = {
      boundaryUuid,
      results: new Map(),
      inputs: new Map(),
    }
    sessionMicroCompactState.set(sessionId, state)
  }

  for (let i = 0; i < original.length; i++) {
    const before = original[i]
    const after = projected[i]
    if (
      !before ||
      !after ||
      !isRoleMessage(before) ||
      !isRoleMessage(after) ||
      !before.uuid
    ) {
      continue
    }
    if (before.role === 'tool' && after.role === 'tool') {
      for (let j = 0; j < before.content.length; j++) {
        const priorPart = before.content[j]
        const nextPart = after.content[j]
        if (!priorPart || !nextPart || priorPart === nextPart) continue
        state.results.set(stateKey(before.uuid, priorPart.toolCallId), {
          messageUuid: before.uuid,
          toolCallId: priorPart.toolCallId,
          replacement: toolResultOutputToText(nextPart.output),
        })
      }
    } else if (before.role === 'assistant' && after.role === 'assistant') {
      for (let j = 0; j < before.content.length; j++) {
        const priorPart = before.content[j]
        const nextPart = after.content[j]
        if (
          priorPart?.type !== 'tool-call' ||
          nextPart?.type !== 'tool-call' ||
          priorPart === nextPart
        ) {
          continue
        }
        state.inputs.set(stateKey(before.uuid, priorPart.toolCallId), {
          messageUuid: before.uuid,
          toolCallId: priorPart.toolCallId,
        })
      }
    }
  }
  persistState(sessionId)
}

/**
 * Re-estimate token count after micro-compaction. Avoids full
 * re-estimation if we know how many tokens were freed.
 */
export function estimateAfterMicroCompact(
  messages: Message[],
  priorTotal: number,
  freed: number,
): number {
  if (freed > 0) return priorTotal - freed
  let t = 0
  for (const m of messages) t += estimateMessageTokens(m)
  return t
}

// ── Internals ───────────────────────────────────────────

function clearToolResults(
  m: ToolMessage,
  sessionId: string | undefined,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
  readAbsById: Map<string, string>,
  clearedReadAbsPaths: Set<string>,
  cwd: string | undefined,
  clearSet: ReadonlySet<string>,
): ToolMessage {
  let touched = false
  const newContent = m.content.map(part => {
    if (!clearSet.has(part.toolCallId)) return part
    const text = toolResultOutputToText(part.output)
    const clearable =
      CLEARABLE_TOOL_RESULTS.has(part.toolName) ||
      text.length >= CLEARABLE_MIN_CHARS
    if (!clearable) return part
    if (text === MICRO_COMPACT_MARKER || isPersistedReference(text)) return part

    if (part.toolName === FILE_READ_TOOL_NAME) {
      const fromTur = absFromToolUseResult(part.toolUseResult, cwd)
      const fromCall = readAbsById.get(part.toolCallId)
      const abs = fromTur ?? fromCall
      if (abs) clearedReadAbsPaths.add(abs)
    }

    const replacement = offloadReferenceForCompact(
      sessionId,
      part.toolCallId,
      part.toolName,
      text,
      MICRO_COMPACT_MARKER,
    )
    const bytesPerToken = bytesPerTokenForToolResult(part.toolName)
    addFreed(
      Math.max(
        0,
        roughTokenCountEstimation(text, bytesPerToken) -
          roughTokenCountEstimation(replacement, bytesPerToken),
      ),
    )
    bumpCleared()
    touched = true
    return { ...part, output: { type: 'text' as const, value: replacement } }
  })
  return touched ? ({ ...m, content: newContent } as ToolMessage) : m
}

function clearToolInputs(
  m: AssistantMessage,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
  clearSet: ReadonlySet<string>,
): AssistantMessage {
  let touched = false
  const newContent = m.content.map(part => {
    if (part.type !== 'tool-call') return part
    if (!clearSet.has(part.toolCallId)) return part
    if (!CLEARABLE_TOOL_INPUTS.has(part.toolName)) return part
    const argsJson = JSON.stringify(part.input ?? {})
    if (argsJson === MARKER_INPUT_JSON) return part
    addFreed(
      Math.max(0, roughTokenCountEstimation(argsJson) - MARKER_INPUT_COST),
    )
    bumpCleared()
    touched = true
    return { ...part, input: { ...MICRO_COMPACT_INPUT_MARKER } }
  })
  return touched ? ({ ...m, content: newContent } as AssistantMessage) : m
}
