/** Extract path-like tokens from user text for conditional skill activation. */
export function extractFilePathCandidates(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()
  const backtickRe = /`([^`\n]{1,256})`/g
  for (const m of text.matchAll(backtickRe)) {
    const candidate = m[1]!.trim()
    if (/[./\\]/.test(candidate) && !candidate.includes(' ')) {
      out.add(candidate)
    }
  }
  const bareRe =
    /(?<![\w@/:])([./\w-]+\/[\w./-]+|[\w-]+\.[A-Za-z][\w]{0,9})(?![\w/])/g
  for (const m of text.matchAll(bareRe)) {
    out.add(m[1]!)
  }
  return [...out]
}
