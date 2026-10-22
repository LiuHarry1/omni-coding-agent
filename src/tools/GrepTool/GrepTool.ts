/**
 * Grep tool — regex search across files, backed by ripgrep (with pure-Node
 * fallback when `rg` isn't installed).
 *
 * Dual-channel:
 *   execute → `{ data: GrepOutput }`
 *   mapToolResultToToolResultBlockParam → model-facing text
 *   UI reads `toolUseResult` (includes per-file matchCount for result cards)
 */

import { tool } from 'ai'
import { z } from 'zod'
import { stat } from 'fs/promises'
import * as path from 'path'
import { ripGrep } from '../../utils/ripgrep.js'
import { resolvePath } from '../utils.js'
import {
  assertAccessibleResolved,
  checkReadPermissionForTool,
  filePathFromInput,
  policyFromContext,
} from '../../utils/permissions/filesystem.js'
import type {
  DualChannelToolResult,
  ToolDefinition,
  ToolResultBlockParam,
} from '../../core/types.js'
import { AGENT_TOOL_NAME, GREP_TOOL_NAME } from '../../constants/tool_names.js'
import { getAvailableShellToolNames } from '../../core/shell/shell-utils.js'
import { buildRgExcludeGlobs } from '../../constants/file_filters.js'
import { isWorkerExecutionBackend } from '../../execution/worker-execution-backend.js'

const DEFAULT_HEAD_LIMIT = 250

export const GrepFileHitSchema = z.object({
  path: z.string(),
  matchCount: z.number(),
})

export const GrepOutputSchema = z.object({
  mode: z.enum(['content', 'files_with_matches', 'count']),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  files: z.array(GrepFileHitSchema),
  content: z.string().optional(),
  numLines: z.number().optional(),
  numMatches: z.number().optional(),
  appliedLimit: z.number().optional(),
  appliedOffset: z.number().optional(),
})

export type GrepOutput = z.infer<typeof GrepOutputSchema>
export type GrepFileHit = z.infer<typeof GrepFileHitSchema>

function getDescription(): string {
  const shellAvoid = getAvailableShellToolNames()
    .map(name => `\`${name}\``)
    .join(' or ')
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${shellAvoid} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`
}

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function splitGlobPatterns(glob: string): string[] {
  const globPatterns: string[] = []
  const rawPatterns = glob.split(/\s+/)
  for (const rawPattern of rawPatterns) {
    if (rawPattern.includes('{') && rawPattern.includes('}')) {
      globPatterns.push(rawPattern)
    } else {
      globPatterns.push(...rawPattern.split(',').filter(Boolean))
    }
  }
  return globPatterns.filter(Boolean)
}

interface GrepArgs {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-B'?: number
  '-A'?: number
  '-C'?: number
  context?: number
  '-n'?: boolean
  '-i'?: boolean
  head_limit?: number
  offset?: number
  multiline?: boolean
}

/** Parse ripgrep content line: path:line:text | path:line-text | line:text | line-text */
function parseRgContentLine(
  raw: string,
  fallbackPath?: string,
): {
  file: string
  lineNo: string
  kind: 'match' | 'context'
  text: string
} | null {
  if (!raw || raw === '--') return null
  if (raw.startsWith('[Showing results')) return null
  if (raw === 'No matches found') return null
  const m = raw.match(/^(?:(.+?):)?(\d+)([:-])(.*)$/)
  if (!m) return null
  return {
    file: m[1] || fallbackPath || '(file)',
    lineNo: m[2]!,
    kind: m[3] === ':' ? 'match' : 'context',
    text: m[4] ?? '',
  }
}

function groupContentByFile(
  lines: string[],
  fallbackPath?: string,
): GrepFileHit[] {
  const counts = new Map<string, number>()
  for (const raw of lines) {
    const row = parseRgContentLine(raw, fallbackPath)
    if (!row || row.kind !== 'match') continue
    counts.set(row.file, (counts.get(row.file) ?? 0) + 1)
  }
  return [...counts.entries()].map(([p, matchCount]) => ({
    path: p,
    matchCount,
  }))
}

/** Rewrite absolute path prefix on an rg content line to cwd-relative. */
function toRelativeContentLine(
  line: string,
  toRelative: (abs: string) => string,
): string {
  const m = line.match(/^(.+?):(\d+)([:-])(.*)$/)
  if (!m) return line
  return `${toRelative(m[1]!)}:${m[2]}${m[3]}${m[4] ?? ''}`
}

function parseCountLines(lines: string[]): {
  files: GrepFileHit[]
  numMatches: number
} {
  const files: GrepFileHit[] = []
  let numMatches = 0
  for (const line of lines) {
    if (!line || line.startsWith('Found ')) continue
    const colonIndex = line.lastIndexOf(':')
    if (colonIndex <= 0) continue
    const filePath = line.slice(0, colonIndex)
    const count = parseInt(line.slice(colonIndex + 1), 10)
    if (Number.isNaN(count)) continue
    files.push({ path: filePath, matchCount: count })
    numMatches += count
  }
  return { files, numMatches }
}

async function enrichFilesWithCounts(
  relativePaths: string[],
  absoluteSearchRoot: string,
  cwd: string,
  opts: {
    pattern: string
    case_insensitive: boolean
    multiline: boolean
    type?: string
    glob?: string
  },
  signal: AbortSignal,
): Promise<GrepFileHit[]> {
  if (relativePaths.length === 0) return []
  const args: string[] = [
    '--hidden',
    ...buildRgExcludeGlobs('vcs'),
    '--max-columns',
    '500',
  ]
  if (opts.multiline) args.push('-U', '--multiline-dotall')
  if (opts.case_insensitive) args.push('-i')
  args.push('-c')
  if (opts.pattern.startsWith('-')) {
    args.push('-e', opts.pattern)
  } else {
    args.push(opts.pattern)
  }
  if (opts.type) args.push('--type', opts.type)
  if (opts.glob) {
    for (const g of splitGlobPatterns(opts.glob)) {
      args.push('--glob', g)
    }
  }

  try {
    const countLines = await ripGrep(args, absoluteSearchRoot, signal)
    const byRel = new Map<string, number>()
    for (const line of countLines) {
      const colonIndex = line.lastIndexOf(':')
      if (colonIndex <= 0) continue
      const abs = line.slice(0, colonIndex)
      const count = parseInt(line.slice(colonIndex + 1), 10)
      if (Number.isNaN(count)) continue
      const rel = path.relative(cwd, abs).replaceAll('\\', '/') || abs
      byRel.set(rel, count)
    }
    return relativePaths.map(p => ({
      path: p,
      matchCount: byRel.get(p) ?? 1,
    }))
  } catch {
    return relativePaths.map(p => ({ path: p, matchCount: 1 }))
  }
}

function mapGrepOutputToToolResult(
  output: GrepOutput,
  toolUseID: string,
): ToolResultBlockParam {
  const {
    mode = 'files_with_matches',
    numFiles,
    filenames,
    content,
    numMatches,
    appliedLimit,
    appliedOffset,
  } = output
  const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)

  if (mode === 'content') {
    const resultContent = content || 'No matches found'
    const finalContent = limitInfo
      ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
      : resultContent
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: finalContent,
    }
  }

  if (mode === 'count') {
    const rawContent = content || 'No matches found'
    const matches = numMatches ?? 0
    const files = numFiles ?? 0
    const summary = `\n\nFound ${matches} total ${
      matches === 1 ? 'occurrence' : 'occurrences'
    } across ${files} ${files === 1 ? 'file' : 'files'}.${
      limitInfo ? ` with pagination = ${limitInfo}` : ''
    }`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: rawContent + summary,
    }
  }

  if (numFiles === 0) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: 'No files found',
    }
  }
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: `Found ${numFiles} ${plural(numFiles, 'file')}${
      limitInfo ? ` ${limitInfo}` : ''
    }\n${filenames.join('\n')}`,
  }
}

function parseRemoteStdoutToOutput(
  stdout: string,
  output_mode: GrepOutput['mode'],
  fallbackPath?: string,
): GrepOutput {
  const lines = stdout.split('\n').filter(l => l.length > 0)
  if (output_mode === 'count') {
    const { files, numMatches } = parseCountLines(lines)
    return {
      mode: 'count',
      numFiles: files.length,
      filenames: files.map(f => f.path),
      files,
      content: files.map(f => `${f.path}:${f.matchCount}`).join('\n'),
      numMatches,
    }
  }
  if (output_mode === 'content') {
    const content = lines.join('\n') || 'No matches found'
    const files = groupContentByFile(lines, fallbackPath)
    return {
      mode: 'content',
      numFiles: files.length,
      filenames: files.map(f => f.path),
      files,
      content,
      numLines: lines.length,
      numMatches: files.reduce((s, f) => s + f.matchCount, 0),
    }
  }
  // files_with_matches — remote -l has no counts; default matchCount 1
  const filenames = lines.filter(l => !l.startsWith('Found '))
  const files = filenames.map(p => ({ path: p, matchCount: 1 }))
  return {
    mode: 'files_with_matches',
    numFiles: files.length,
    filenames,
    files,
  }
}

export const definition: ToolDefinition = {
  name: GREP_TOOL_NAME,
  description: 'Regex search across files (ripgrep)',
  isConcurrencySafe: () => true,
  outputSchema: GrepOutputSchema,
  checkPermissions(input, ctx) {
    return checkReadPermissionForTool(
      ctx.cwd,
      ctx.permissionContext,
      input,
      ['path'],
      ctx.cwd,
      GREP_TOOL_NAME,
    )
  },
  getPath(input) {
    return filePathFromInput(input, ['path'])
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return mapGrepOutputToToolResult(output as GrepOutput, toolUseID)
  },
  create(cwd, toolContext) {
    return tool({
      description: getDescription(),
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            'The regular expression pattern to search for in file contents',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'File or directory to search in (rg PATH). Defaults to current working directory.',
          ),
        glob: z
          .string()
          .optional()
          .describe(
            'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
          ),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .describe(
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
          ),
        '-B': z
          .number()
          .optional()
          .describe(
            'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
          ),
        '-A': z
          .number()
          .optional()
          .describe(
            'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
          ),
        '-C': z.number().optional().describe('Alias for context.'),
        context: z
          .number()
          .optional()
          .describe(
            'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
          ),
        '-n': z
          .boolean()
          .optional()
          .describe(
            'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
          ),
        '-i': z
          .boolean()
          .optional()
          .describe('Case insensitive search (rg -i)'),
        type: z
          .string()
          .optional()
          .describe(
            'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
          ),
        head_limit: z
          .number()
          .optional()
          .describe(
            `Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to ${DEFAULT_HEAD_LIMIT} when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).`,
          ),
        offset: z
          .number()
          .optional()
          .describe(
            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
          ),
        multiline: z
          .boolean()
          .optional()
          .describe(
            'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
          ),
      }),
      execute: async (
        rawArgs: GrepArgs,
      ): Promise<DualChannelToolResult<GrepOutput> | string> => {
        const {
          pattern,
          path: inputPath,
          glob,
          type,
          output_mode = 'files_with_matches',
          '-B': context_before,
          '-A': context_after,
          '-C': context_c,
          context,
          '-n': show_line_numbers = true,
          '-i': case_insensitive = false,
          head_limit,
          offset = 0,
          multiline = false,
        } = rawArgs

        const execution = toolContext.execution
        // Local Worker uses native ripGrep below. Remote (SSH) uses Worker
        // `rg` RPC — argv spawn, exit 0/1 = success.
        const useRemoteRg =
          !!execution &&
          !(
            isWorkerExecutionBackend(execution) &&
            execution.environmentId === 'local'
          )
        if (useRemoteRg && execution) {
          try {
            const abs = execution.resolve(cwd, inputPath ?? '.')
            execution.assertInWorkspace(cwd, abs, 'read')
            const rgArgs: string[] = ['--hidden', '--max-columns', '500']
            if (multiline) rgArgs.push('-U', '--multiline-dotall')
            if (case_insensitive) rgArgs.push('-i')
            if (output_mode === 'files_with_matches') rgArgs.push('-l')
            else if (output_mode === 'count') rgArgs.push('-c')
            if (show_line_numbers && output_mode === 'content')
              rgArgs.push('-n')
            const ctx = context ?? context_c
            if (output_mode === 'content') {
              if (ctx !== undefined) rgArgs.push('-C', String(ctx))
              else {
                if (context_before !== undefined)
                  rgArgs.push('-B', String(context_before))
                if (context_after !== undefined)
                  rgArgs.push('-A', String(context_after))
              }
            }
            if (glob) rgArgs.push('--glob', glob)
            if (type) rgArgs.push('--type', type)
            rgArgs.push('--', pattern)
            const lines = await execution.rg(rgArgs, abs, { timeoutMs: 60_000 })
            let out = lines.join('\n')
            if (!out.trim()) {
              return {
                data:
                  output_mode === 'content'
                    ? {
                        mode: 'content',
                        numFiles: 0,
                        filenames: [],
                        files: [],
                        content: 'No matches found',
                        numLines: 0,
                        numMatches: 0,
                      }
                    : output_mode === 'count'
                      ? {
                          mode: 'count',
                          numFiles: 0,
                          filenames: [],
                          files: [],
                          content: 'No matches found',
                          numMatches: 0,
                        }
                      : {
                          mode: 'files_with_matches',
                          numFiles: 0,
                          filenames: [],
                          files: [],
                        },
              }
            }
            if (head_limit && head_limit > 0) {
              out = out
                .split('\n')
                .slice(offset, offset + head_limit)
                .join('\n')
            } else if (offset) {
              out = out.split('\n').slice(offset).join('\n')
            }
            const data = parseRemoteStdoutToOutput(out, output_mode, inputPath)
            return { data }
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        const resolved = resolvePath(cwd, inputPath ?? '.')
        if ('error' in resolved) {
          return `Error: ${resolved.error || 'Invalid path'}`
        }
        const absolutePath = resolved.abs

        try {
          assertAccessibleResolved(
            absolutePath,
            policyFromContext(cwd, toolContext.permissionContext),
            'read',
          )
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }

        const args: string[] = [
          '--hidden',
          ...buildRgExcludeGlobs('vcs'),
          '--max-columns',
          '500',
        ]
        if (multiline) args.push('-U', '--multiline-dotall')
        if (case_insensitive) args.push('-i')
        if (output_mode === 'files_with_matches') args.push('-l')
        else if (output_mode === 'count') args.push('-c')
        if (show_line_numbers && output_mode === 'content') args.push('-n')
        if (output_mode === 'content') {
          if (context !== undefined) args.push('-C', context.toString())
          else if (context_c !== undefined)
            args.push('-C', context_c.toString())
          else {
            if (context_before !== undefined)
              args.push('-B', context_before.toString())
            if (context_after !== undefined)
              args.push('-A', context_after.toString())
          }
        }
        if (pattern.startsWith('-')) args.push('-e', pattern)
        else args.push(pattern)
        if (type) args.push('--type', type)
        if (glob) {
          for (const g of splitGlobPatterns(glob)) args.push('--glob', g)
        }

        const abortController = new AbortController()
        let results: string[]
        try {
          results = await ripGrep(args, absolutePath, abortController.signal)
        } catch (e: unknown) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        const toRelative = (abs: string): string => {
          const rel = path.relative(cwd, abs)
          return (rel === '' ? abs : rel).replaceAll('\\', '/')
        }

        if (output_mode === 'content') {
          const { items: limitedResults, appliedLimit } = applyHeadLimit(
            results,
            head_limit,
            offset,
          )
          const finalLines = limitedResults.map(line =>
            toRelativeContentLine(line, toRelative),
          )
          const content = finalLines.join('\n') || 'No matches found'
          const files = groupContentByFile(finalLines, inputPath)
          const data: GrepOutput = {
            mode: 'content',
            numFiles: files.length,
            filenames: files.map(f => f.path),
            files,
            content,
            numLines: finalLines.length,
            numMatches: files.reduce((s, f) => s + f.matchCount, 0),
            ...(appliedLimit !== undefined && { appliedLimit }),
            ...(offset > 0 && { appliedOffset: offset }),
          }
          return { data }
        }

        if (output_mode === 'count') {
          const { items: limitedResults, appliedLimit } = applyHeadLimit(
            results,
            head_limit,
            offset,
          )
          const finalCountLines = limitedResults.map(line => {
            const colonIndex = line.lastIndexOf(':')
            if (colonIndex > 0) {
              const filePath = line.substring(0, colonIndex)
              const count = line.substring(colonIndex)
              return toRelative(filePath) + count
            }
            return line
          })
          const { files, numMatches } = parseCountLines(finalCountLines)
          const data: GrepOutput = {
            mode: 'count',
            numFiles: files.length,
            filenames: files.map(f => f.path),
            files,
            content: finalCountLines.join('\n') || 'No matches found',
            numMatches,
            ...(appliedLimit !== undefined && { appliedLimit }),
            ...(offset > 0 && { appliedOffset: offset }),
          }
          return { data }
        }

        // files_with_matches
        const stats = await Promise.allSettled(results.map(r => stat(r)))
        const sortedMatches = results
          .map((r, i) => {
            const s = stats[i]!
            return [
              r,
              s.status === 'fulfilled' ? (s.value.mtimeMs ?? 0) : 0,
            ] as const
          })
          .sort((a, b) => {
            const timeComparison = b[1] - a[1]
            if (timeComparison === 0) return a[0].localeCompare(b[0])
            return timeComparison
          })
          .map(entry => entry[0])

        const { items: finalMatches, appliedLimit } = applyHeadLimit(
          sortedMatches,
          head_limit,
          offset,
        )
        const relativeMatches = finalMatches.map(toRelative)
        const files = await enrichFilesWithCounts(
          relativeMatches,
          absolutePath,
          cwd,
          {
            pattern,
            case_insensitive,
            multiline,
            type,
            glob,
          },
          abortController.signal,
        )
        const data: GrepOutput = {
          mode: 'files_with_matches',
          filenames: relativeMatches,
          numFiles: relativeMatches.length,
          files,
          ...(appliedLimit !== undefined && { appliedLimit }),
          ...(offset > 0 && { appliedOffset: offset }),
        }
        return { data }
      },
    })
  },
}
