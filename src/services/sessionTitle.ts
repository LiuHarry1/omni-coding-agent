/**
 * Session title generation via the small-model tier.
 *
 * Short structured title, no tools; failures return null so callers can
 * fall back to a heuristic.
 */

import { generateText } from 'ai'
import type { IProvider } from './llm/types.js'

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`

function extractJsonTitle(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as { title?: unknown }
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title.trim()
    }
  } catch {
    // try fenced / embedded JSON
  }
  const match = trimmed.match(/\{[\s\S]*"title"\s*:\s*"([^"]+)"[\s\S]*\}/)
  if (match?.[1]?.trim()) return match[1].trim()
  // plain one-line fallback if model ignored JSON
  const line = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('{'))
  if (line && line.split(/\s+/).length <= 10)
    return line.replace(/^["']|["']$/g, '')
  return null
}

/**
 * Generate a sentence-case session title from the first user message.
 * Returns null on error or unparseable response.
 */
export async function generateSessionTitle(
  description: string,
  provider: IProvider,
  modelId?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const trimmed = description.trim()
  if (!trimmed) return null

  try {
    const model = modelId ?? provider.defaultModelId()
    const result = await generateText({
      model: provider.chatModel(model),
      system: SESSION_TITLE_PROMPT,
      prompt: trimmed.slice(0, 1000),
      maxOutputTokens: 64,
      abortSignal: signal,
      ...provider.streamTextExtras(),
    })
    return extractJsonTitle(result.text)
  } catch (error) {
    console.warn(`[sessionTitle] generateSessionTitle failed: ${error}`)
    return null
  }
}
