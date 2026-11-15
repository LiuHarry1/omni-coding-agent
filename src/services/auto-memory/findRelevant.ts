/**
 * Select relevant topic memory files for a user query.
 */
import type { IProvider } from '../llm/types.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'
import { memoryHeader } from './memoryAge.js'
import {
  formatMemoryManifest,
  readFileCapped,
  scanMemoryFiles,
  type MemoryFileMeta,
} from './scan.js'
import { selectedMemoriesJsonSchema, sideQueryJson } from './sideQuery.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

export type FastRelevantMemory = RelevantMemory & {
  score: number
}

export type FastRelevantResult = {
  matches: FastRelevantMemory[]
  strong: boolean
}

export type SurfacedMemory = {
  path: string
  content: string
  mtimeMs: number
  header: string
  limit?: number
}

export const MAX_MEMORY_LINES = 200
export const MAX_MEMORY_BYTES = 4096
export const MAX_SESSION_BYTES = 60 * 1024
const MAX_FAST_MEMORIES = 3
const FAST_STRONG_SCORE = 0.82
const FAST_MIN_MARGIN = 0.12
const FAST_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

const FAST_STOP_WORDS = new Set([
  'about',
  'and',
  'for',
  'from',
  'memory',
  'please',
  'that',
  'the',
  'this',
  'what',
  'with',
  '之前',
  '什么',
  '记忆',
  '这个',
  '那个',
])

function normalizeFastText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^\p{L}\p{N}_./:-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function fastTokens(value: string): string[] {
  const normalized = normalizeFastText(value)
  if (!normalized) return []
  const out = new Set<string>()
  for (const part of FAST_SEGMENTER.segment(normalized)) {
    if (!part.isWordLike) continue
    const token = part.segment.trim()
    if (
      [...token].length < 2 ||
      FAST_STOP_WORDS.has(token) ||
      /^\d+$/u.test(token)
    ) {
      continue
    }
    out.add(token)
  }
  return [...out]
}

function includesPhrase(haystack: string, needle: string): boolean {
  if ([...needle].length < 3) return false
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      needle,
    )
  ) {
    return haystack.includes(needle)
  }
  return (
    haystack === needle ||
    haystack.startsWith(`${needle} `) ||
    haystack.endsWith(` ${needle}`) ||
    haystack.includes(` ${needle} `)
  )
}

function overlapCount(
  left: readonly string[],
  right: readonly string[],
): number {
  const rightSet = new Set(right)
  return left.reduce((count, token) => count + Number(rightSet.has(token)), 0)
}

function scoreFastMemory(
  query: string,
  queryTokens: readonly string[],
  memory: MemoryFileMeta,
): { score: number; exact: boolean } {
  const normalizedQuery = normalizeFastText(query)
  const normalizedFilename = normalizeFastText(memory.filename)
  const basename = normalizedFilename.split('/').at(-1) ?? normalizedFilename
  const stem = basename.replace(/\.md$/u, '')
  const normalizedName = normalizeFastText(memory.name ?? '')

  if (
    includesPhrase(normalizedQuery, normalizedFilename) ||
    includesPhrase(normalizedQuery, basename) ||
    includesPhrase(normalizedQuery, stem) ||
    includesPhrase(normalizedQuery, normalizedName)
  ) {
    return { score: 1, exact: true }
  }

  const identityTokens = fastTokens(`${memory.filename} ${memory.name ?? ''}`)
  const descriptionTokens = fastTokens(memory.description ?? '')
  const identityOverlap = overlapCount(queryTokens, identityTokens)
  const descriptionOverlap = overlapCount(queryTokens, descriptionTokens)
  const queryTokenCount = Math.max(1, queryTokens.length)

  // Metadata overlap is intentionally conservative: descriptions rank a
  // candidate, but only two or more independent signals can become strong.
  const identityCoverage = identityOverlap / queryTokenCount
  const descriptionCoverage = descriptionOverlap / queryTokenCount
  const score = Math.min(
    0.9,
    identityCoverage * 0.62 +
      descriptionCoverage * 0.28 +
      Math.min(0.1, (identityOverlap + descriptionOverlap) * 0.025),
  )
  return { score, exact: false }
}

/**
 * Deterministic metadata-only lane. It never reads memory bodies and only
 * reports a strong hit for an exact identity phrase or a uniquely leading
 * high-confidence metadata match.
 */
export function findFastRelevantMemories(
  query: string,
  memoryDir: string,
  alreadySurfaced: ReadonlySet<string> = new Set(),
): FastRelevantResult {
  const queryTokens = fastTokens(query)
  const ranked = scanMemoryFiles(memoryDir)
    .filter(memory => !alreadySurfaced.has(memory.filePath))
    .map(memory => ({
      memory,
      ...scoreFastMemory(query, queryTokens, memory),
    }))
    .filter(candidate => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.memory.mtimeMs - left.memory.mtimeMs ||
        left.memory.filename.localeCompare(right.memory.filename),
    )

  const exact = ranked.filter(candidate => candidate.exact)
  if (exact.length > 0) {
    return {
      matches: exact.slice(0, MAX_FAST_MEMORIES).map(candidate => ({
        path: candidate.memory.filePath,
        mtimeMs: candidate.memory.mtimeMs,
        score: candidate.score,
      })),
      strong: true,
    }
  }

  const first = ranked[0]
  const second = ranked[1]
  const uniquelyStrong =
    first != null &&
    first.score >= FAST_STRONG_SCORE &&
    (second == null || first.score - second.score >= FAST_MIN_MARGIN)
  if (!uniquelyStrong || !first) return { matches: [], strong: false }
  return {
    matches: [
      {
        path: first.memory.filePath,
        mtimeMs: first.memory.mtimeMs,
        score: first.score,
      },
    ],
    strong: true,
  }
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to the coding agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful as the agent processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

export type SelectRelevantFn = (
  query: string,
  memories: MemoryFileMeta[],
  recentTools: readonly string[],
  signal?: AbortSignal,
) => Promise<string[]>

export type FindRelevantOpts = {
  provider: IProvider
  modelId: string
  signal?: AbortSignal
  /** Injected selector for tests. */
  selectFn?: SelectRelevantFn
}

/**
 * Find up to 5 relevant topic files. Excludes MEMORY.md (via scan).
 * `alreadySurfaced` filters before the selector call.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  opts: FindRelevantOpts,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = scanMemoryFiles(memoryDir).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) return []

  const select =
    opts.selectFn ??
    createSelectRelevantMemories({
      provider: opts.provider,
      modelId: opts.modelId,
    })
  const selectedFilenames = await select(
    query,
    memories,
    recentTools,
    opts.signal,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  return selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryFileMeta => m !== undefined)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

export function createSelectRelevantMemories(opts: {
  provider: IProvider
  modelId: string
}): SelectRelevantFn {
  return async (query, memories, recentTools, signal) => {
    const validFilenames = new Set(memories.map(m => m.filename))
    const manifest = formatMemoryManifest(memories)
    const toolsSection =
      recentTools.length > 0
        ? `\n\nRecently used tools: ${recentTools.join(', ')}`
        : ''
    const parsed = await sideQueryJson({
      provider: opts.provider,
      modelId: opts.modelId,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      user: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
      schema: selectedMemoriesJsonSchema,
      maxOutputTokens: 256,
      signal,
    })
    if (!parsed) return []
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  }
}

export function readMemoriesForSurfacingSync(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): SurfacedMemory[] {
  const results: Array<SurfacedMemory | null> = selected.map(
    ({ path: filePath, mtimeMs }) => {
      if (signal?.aborted) return null
      try {
        const result = readFileCapped(
          filePath,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
        )
        const truncated =
          result.truncatedByLines ||
          result.truncatedByBytes ||
          result.totalLines > MAX_MEMORY_LINES
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        const surfaced: SurfacedMemory = {
          path: filePath,
          content,
          mtimeMs: result.mtimeMs || mtimeMs,
          header: memoryHeader(filePath, result.mtimeMs || mtimeMs),
        }
        if (truncated) surfaced.limit = result.lineCount
        return surfaced
      } catch {
        return null
      }
    },
  )
  return results.filter((r): r is SurfacedMemory => r !== null)
}

export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<SurfacedMemory[]> {
  return readMemoriesForSurfacingSync(selected, signal)
}
