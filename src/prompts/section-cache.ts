/**
 * System prompt sections that are computed once per session and reused until
 * the conversation is summarized. Recomputing them every turn would change
 * the system prompt whenever their source changes (a memory write, say) and
 * throw away the prompt cache with it.
 */
const sections = new Map<string, Map<string, string>>()

export function cachedPromptSection(
  sessionId: string,
  name: string,
  compute: () => string,
): string {
  let cache = sections.get(sessionId)
  if (!cache) {
    cache = new Map()
    sections.set(sessionId, cache)
  }
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const value = compute()
  cache.set(name, value)
  return value
}

/** Recompute every section on next use: after a summary, or when the session goes away. */
export function clearPromptSections(sessionId: string): void {
  sections.delete(sessionId)
}
