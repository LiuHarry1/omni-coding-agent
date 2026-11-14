/**
 * Aggregate budget for the tool results of one step.
 *
 * The execute-time cap in `index.ts` bounds each result on its own, so ten
 * parallel Greps of 30k chars each pass it and still put 300k chars into a
 * single message. Here the results that will share one tool message are
 * measured together, and the largest are moved to disk until the message
 * fits, following Claude Code's `enforceToolResultBudget`.
 *
 * Claude Code keeps full results in memory and re-applies its replacements
 * on every request, so it has to remember each decision to keep the prompt
 * cache prefix stable. Our transcript stores what the model saw: a result is
 * replaced once, before its message is committed, and stays that way across
 * later turns, resume and forks without any replay state.
 */
import {
  buildLargeResultPreview,
  getPersistThresholdChars,
  isPersistedReference,
  isToolResultsHostOnly,
  writeToolResultFile,
} from './index.js'

/** Claude Code `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

export function getPerMessageBudgetLimit(): number {
  const raw = process.env.TOOL_RESULTS_PER_MESSAGE_CHARS
  const override = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(override) && override > 0
    ? override
    : MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

type BudgetedResult = {
  toolCallId: string
  toolName: string
  result: string
  /** Set when the result carries images, which are never moved to disk. */
  resultBlocks?: unknown
}

/**
 * Results that count towards the budget and may be moved to disk. Left out,
 * as in Claude Code: results already replaced by a reference, results with
 * images, and tools that bound their own output (Read), whose spill file
 * the model would only read back with the same tool.
 */
function isCandidate(result: BudgetedResult): boolean {
  return (
    result.result.length > 0 &&
    !result.resultBlocks &&
    !isPersistedReference(result.result) &&
    Number.isFinite(getPersistThresholdChars(result.toolName))
  )
}

/** Largest first, until what stays inline fits the limit. */
function selectToReplace<T extends BudgetedResult>(
  candidates: T[],
  limit: number,
): T[] {
  const selected: T[] = []
  let remaining = candidates.reduce((sum, c) => sum + c.result.length, 0)
  for (const c of [...candidates].sort(
    (a, b) => b.result.length - a.result.length,
  )) {
    if (remaining <= limit) break
    selected.push(c)
    // The preview that replaces it is ~2k, small next to anything picked here.
    remaining -= c.result.length
  }
  return selected
}

/**
 * Keep one step's tool results within the per-message budget. Returns the
 * same array when nothing had to move; otherwise a copy where the largest
 * results are replaced by a preview and the path of the full output.
 */
export function enforceToolResultBudget<T extends BudgetedResult>(
  results: T[],
  sessionId: string | undefined,
  limit = getPerMessageBudgetLimit(),
): T[] {
  if (!sessionId) return results
  const candidates = results.filter(isCandidate)
  const total = candidates.reduce((sum, c) => sum + c.result.length, 0)
  if (total <= limit) return results

  const hostOnly = isToolResultsHostOnly(sessionId)
  const replacements = new Map<string, string>()
  let shed = 0
  for (const c of selectToReplace(candidates, limit)) {
    const filePath = writeToolResultFile(
      sessionId,
      c.toolCallId,
      c.toolName,
      c.result,
    )
    // A result that could not be written stays inline.
    if (!filePath) continue
    replacements.set(
      c.toolCallId,
      buildLargeResultPreview(filePath, c.toolName, c.result, hostOnly),
    )
    shed += c.result.length
  }
  if (replacements.size === 0) return results

  console.log(
    `[tool-storage] per-message budget: ${total} chars across ${candidates.length} results ` +
      `exceeds ${limit} -- moved ${replacements.size} to disk, shed ~${shed} chars`,
  )
  return results.map(r => {
    const replacement = replacements.get(r.toolCallId)
    return replacement === undefined ? r : { ...r, result: replacement }
  })
}
