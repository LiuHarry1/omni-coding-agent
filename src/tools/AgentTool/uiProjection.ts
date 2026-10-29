import type { Message } from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import { toolResultOutputToText } from '../../utils/tool-result-content.js'
import { projectToolUseResult } from '../../utils/project-tool-use-result.js'

const MAX_STEPS = 100
const MAX_TOTAL_BYTES = 128 * 1024
const MAX_RESULT_CHARS = 2_000
const MAX_ARGS_CHARS = 4_000
const MAX_TOOL_USE_RESULT_CHARS = 8_000
const MAX_DEPTH = 4
const MAX_MEMBERS = 40
const MAX_STRING_CHARS = 1_000
const LEADING_STEPS = 6

export type AgentUiStep = {
  type: 'tool_call'
  toolCallId: string
  name: string
  args: Record<string, unknown>
  status: 'done'
  result?: string
  toolUseResult?: unknown
  isError?: boolean
}

export type AgentUiProjection = {
  version: 1
  steps: AgentUiStep[]
  omittedSteps?: number
  detailsTruncated?: true
}

type SanitizeResult = {
  value: unknown
  truncated: boolean
}

function sanitizeJsonValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): SanitizeResult {
  if (
    value == null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return { value, truncated: false }
  }
  if (typeof value === 'string') {
    return value.length <= MAX_STRING_CHARS
      ? { value, truncated: false }
      : { value: `${value.slice(0, MAX_STRING_CHARS - 1)}…`, truncated: true }
  }
  if (
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    value instanceof Uint8Array ||
    Buffer.isBuffer(value)
  ) {
    return { value: undefined, truncated: true }
  }
  if (typeof value !== 'object') {
    return { value: undefined, truncated: true }
  }
  if (depth >= MAX_DEPTH || seen.has(value)) {
    return { value: undefined, truncated: true }
  }

  seen.add(value)
  let truncated = false
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (const item of value.slice(0, MAX_MEMBERS)) {
      const sanitized = sanitizeJsonValue(item, depth + 1, seen)
      truncated ||= sanitized.truncated
      if (sanitized.value !== undefined) output.push(sanitized.value)
    }
    if (value.length > MAX_MEMBERS) truncated = true
    seen.delete(value)
    return { value: output, truncated }
  }

  const output: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, item] of entries.slice(0, MAX_MEMBERS)) {
    const sanitized = sanitizeJsonValue(item, depth + 1, seen)
    truncated ||= sanitized.truncated
    if (sanitized.value !== undefined) output[key] = sanitized.value
  }
  if (entries.length > MAX_MEMBERS) truncated = true
  seen.delete(value)
  return { value: output, truncated }
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function boundedArgs(input: Record<string, unknown>): SanitizeResult {
  const sanitized = sanitizeJsonValue(input)
  const value = (sanitized.value ?? {}) as Record<string, unknown>
  if (serializedLength(value) <= MAX_ARGS_CHARS) return { ...sanitized, value }
  return {
    value: {
      _truncated: true,
      preview: JSON.stringify(value).slice(0, MAX_ARGS_CHARS - 64),
    },
    truncated: true,
  }
}

function boundedToolUseResult(
  toolName: string,
  value: unknown,
): SanitizeResult {
  const projected = projectToolUseResult(toolName, value)
  const sanitized = sanitizeJsonValue(projected)
  if (
    sanitized.value === undefined ||
    serializedLength(sanitized.value) > MAX_TOOL_USE_RESULT_CHARS
  ) {
    return { value: undefined, truncated: value !== undefined }
  }
  return sanitized
}

function truncateResult(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_RESULT_CHARS) {
    return { value, truncated: false }
  }
  return {
    value: `${value.slice(0, MAX_RESULT_CHARS - 1)}…`,
    truncated: true,
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8')
}

export function buildAgentUiProjection(
  messages: readonly Message[],
): AgentUiProjection | undefined {
  const results = new Map<
    string,
    { result: string; toolUseResult?: unknown; isError?: boolean }
  >()
  for (const message of messages) {
    if (!isRoleMessage(message) || message.role !== 'tool') continue
    for (const part of message.content) {
      results.set(part.toolCallId, {
        result: toolResultOutputToText(part.output),
        toolUseResult: part.toolUseResult,
        isError: part.isError,
      })
    }
  }

  const projected: AgentUiStep[] = []
  let detailsTruncated = false
  for (const message of messages) {
    if (!isRoleMessage(message) || message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue
      const args = boundedArgs(part.input ?? {})
      detailsTruncated ||= args.truncated
      const result = results.get(part.toolCallId)
      const step: AgentUiStep = {
        type: 'tool_call',
        toolCallId: part.toolCallId,
        name: part.toolName,
        args: args.value as Record<string, unknown>,
        status: 'done',
      }
      if (result) {
        const text = truncateResult(result.result)
        detailsTruncated ||= text.truncated
        step.result = text.value
        if (result.toolUseResult !== undefined) {
          const toolUseResult = boundedToolUseResult(
            part.toolName,
            result.toolUseResult,
          )
          detailsTruncated ||= toolUseResult.truncated
          if (toolUseResult.value !== undefined) {
            step.toolUseResult = toolUseResult.value
          }
        }
        if (result.isError || result.result.startsWith('Error:')) {
          step.isError = true
        }
      }
      projected.push(step)
    }
  }

  if (projected.length === 0) return undefined

  const candidate =
    projected.length > MAX_STEPS
      ? [
          ...projected.slice(0, LEADING_STEPS),
          ...projected.slice(-(MAX_STEPS - LEADING_STEPS)),
        ]
      : projected
  let omittedSteps = projected.length - candidate.length
  const leading = candidate.slice(0, Math.min(LEADING_STEPS, candidate.length))
  const tail = candidate.slice(leading.length)
  const selected = [...leading]
  for (let i = tail.length - 1; i >= 0; i--) {
    const next = [tail[i]!, ...selected.slice(leading.length)]
    const combined = [...leading, ...next]
    if (
      byteLength({
        version: 1,
        steps: combined,
        omittedSteps: projected.length - combined.length,
        detailsTruncated: true,
      }) <= MAX_TOTAL_BYTES
    ) {
      selected.splice(leading.length, selected.length, ...next)
    } else {
      omittedSteps++
    }
  }

  const projection: AgentUiProjection = {
    version: 1,
    steps: selected,
    ...(omittedSteps > 0 ? { omittedSteps } : {}),
    ...(detailsTruncated || omittedSteps > 0 ? { detailsTruncated: true } : {}),
  }
  return projection
}
