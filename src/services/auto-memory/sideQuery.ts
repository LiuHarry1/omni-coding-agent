/**
 * Single-shot side query for memory relevance selection (no tool loop).
 * sideQuery + json_schema output_format in findRelevantMemories.
 */
import { generateText, Output } from 'ai'
import { jsonSchema, type FlexibleSchema } from '@ai-sdk/provider-utils'
import type { IProvider } from '../llm/types.js'

/** Output schema for the memory relevance selection side query. */
export const selectedMemoriesJsonSchema = jsonSchema<{
  selected_memories: string[]
}>({
  type: 'object',
  properties: {
    selected_memories: { type: 'array', items: { type: 'string' } },
  },
  required: ['selected_memories'],
  additionalProperties: false,
})

export type SelectedMemoriesResult = {
  selected_memories: string[]
}

export type SideQueryJsonOpts<T> = {
  provider: IProvider
  modelId: string
  system: string
  user: string
  schema: FlexibleSchema<T>
  maxOutputTokens?: number
  signal?: AbortSignal
}

/**
 * Side query: system + user messages, strict json_schema via Output.object.
 * Does not use streamTextExtras — scoped to side queries only.
 */
export async function sideQueryJson<T>(
  opts: SideQueryJsonOpts<T>,
): Promise<T | null> {
  try {
    const result = await generateText({
      model: opts.provider.chatModel(opts.modelId),
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      maxOutputTokens: opts.maxOutputTokens ?? 256,
      abortSignal: opts.signal,
      output: Output.object({ schema: opts.schema }),
    })
    if (result.output == null) {
      console.warn(
        `[auto-memory] sideQueryJson failed: no structured output in response`,
      )
      return null
    }
    return result.output
  } catch (e) {
    if (opts.signal?.aborted) return null
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[auto-memory] sideQueryJson failed: ${msg}`)
    return null
  }
}

/** Parse JSON from model text: raw, fenced, or first {...} substring. */
export function parseJsonFromModelText<T>(text: string): T | null {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    return JSON.parse(unfenced) as T
  } catch {
    // fall through
  }
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1)) as T
    } catch {
      return null
    }
  }
  return null
}
