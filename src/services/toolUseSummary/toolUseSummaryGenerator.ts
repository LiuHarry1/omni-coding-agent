/**
 * Tool Use Summary Generator
 *
 * Writes a short label for a finished batch of tool calls with the small
 * model. Prompt and input layout are Claude Code's
 * (services/toolUseSummary/toolUseSummaryGenerator.ts).
 */
import { generateText } from 'ai'
import type { IProvider } from '../llm/types.js'

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`

/** The label is one line; a model that rambles is cut here. */
const MAX_SUMMARY_CHARS = 80
/** A label that has not arrived by now is not worth holding the turn for. */
const SUMMARY_TIMEOUT_MS = 15_000

export type ToolInfo = {
  name: string
  input: unknown
  output: unknown
}

export type GenerateToolUseSummaryParams = {
  tools: ToolInfo[]
  provider: IProvider
  model: string
  signal?: AbortSignal
  lastAssistantText?: string
}

/** A label for one batch of tool calls, with the calls it describes. */
export type ToolUseSummary = {
  summary: string
  precedingToolUseIds: string[]
}

export type GenerateToolUseSummary = typeof generateToolUseSummary

/**
 * Generates a human-readable summary of completed tools.
 *
 * @returns A brief summary string, or null if generation fails
 */
export async function generateToolUseSummary({
  tools,
  provider,
  model,
  signal,
  lastAssistantText,
}: GenerateToolUseSummaryParams): Promise<string | null> {
  if (tools.length === 0) {
    return null
  }

  try {
    // Build a concise representation of what tools did
    const toolSummaries = tools
      .map(tool => {
        const inputStr = truncateJson(tool.input, 300)
        const outputStr = truncateJson(tool.output, 300)
        return `Tool: ${tool.name}\nInput: ${inputStr}\nOutput: ${outputStr}`
      })
      .join('\n\n')

    const contextPrefix = lastAssistantText
      ? `User's intent (from assistant's last message): ${lastAssistantText.slice(0, 200)}\n\n`
      : ''

    const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
    const response = await generateText({
      model: provider.chatModel(model),
      system: TOOL_USE_SUMMARY_SYSTEM_PROMPT,
      prompt: `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`,
      maxOutputTokens: 64,
      maxRetries: 0,
      abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...provider.streamTextExtras(),
    })

    return cleanSummary(response.text)
  } catch (error) {
    // Log but don't fail - summaries are non-critical
    if (!signal?.aborted) {
      console.warn(
        `[toolUseSummary] generation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return null
  }
}

/** The first line of the answer, without list markers or quotes. */
export function cleanSummary(text: string): string | null {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(part => part.length > 0)
  if (!line) return null
  const label = line
    .replace(/^(?:[-*•]\s+|label:\s*)/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
  // Punctuation alone (a bare list marker, empty quotes) says nothing.
  if (!/[\p{L}\p{N}]/u.test(label)) return null
  return label.length <= MAX_SUMMARY_CHARS
    ? label
    : `${label.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`
}

/**
 * Truncates a JSON value to a maximum length for the prompt.
 */
function truncateJson(value: unknown, maxLength: number): string {
  try {
    const str = JSON.stringify(value) ?? 'null'
    if (str.length <= maxLength) {
      return str
    }
    return str.slice(0, maxLength - 3) + '...'
  } catch {
    return '[unable to serialize]'
  }
}
