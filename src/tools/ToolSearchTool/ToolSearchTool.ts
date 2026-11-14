/**
 * ToolSearch — discover deferred tools by name or keyword.
 *
 * excluded from the API tools[] array to save tokens and stabilize prompt
 * cache. The model calls this tool to discover them; the agent loop then
 * activates discovered tools for subsequent steps.
 *
 * Query modes:
 *   - `select:name1,name2`  — exact name lookup (comma-separated)
 *   - `"keyword search"`    — fuzzy match against name + description
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../core/types.js'

import { TOOL_SEARCH_TOOL_NAME } from '../../constants/tool_names.js'

interface DeferredEntry {
  name: string
  description: string
  isMcp: boolean
}

export const ToolSearchOutputSchema = z.object({
  text: z.string(),
  query: z.string(),
  matches: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
})

export type ToolSearchOutput = z.infer<typeof ToolSearchOutputSchema>

function buildIndex(deferredDefs: DeferredEntry[]): Map<string, DeferredEntry> {
  const idx = new Map<string, DeferredEntry>()
  for (const d of deferredDefs) idx.set(d.name, d)
  return idx
}

function matchKeyword(entry: DeferredEntry, keywords: string[]): boolean {
  const haystack = `${entry.name} ${entry.description}`.toLowerCase()
  return keywords.every(kw => haystack.includes(kw))
}

/**
 * `select:a,b` or a bare comma list of known tool names (`browser_click,browser_type`).
 * Keyword search ANDs tokens, so a comma list would otherwise match nothing.
 */
function parseSelectNames(
  trimmed: string,
  index: Map<string, DeferredEntry>,
): string[] | null {
  const prefixed = trimmed.toLowerCase().startsWith('select:')
  const rest = prefixed ? trimmed.slice(7) : trimmed
  if (!prefixed && !rest.includes(',')) return null
  const names = rest
    .split(',')
    .map(n => n.trim())
    .filter(Boolean)
  if (names.length === 0) return null
  if (!prefixed && !names.some(n => index.has(n))) return null
  return names
}

const MAX_KEYWORD_RESULTS = 5

export function createToolSearchDefinition(
  deferredDefs: DeferredEntry[],
): ToolDefinition {
  const index = buildIndex(deferredDefs)
  const nameList = deferredDefs.map(d => d.name).join(', ')

  const description = `Discover deferred tools that are not loaded in the current prompt.

Deferred tools are available by name only — call this tool to load their full description and parameters so you can invoke them.

Do not call this for tools already in your available tools list (including browser_* on the browser agent).

Query modes:
- \`select:name1,name2\` or \`name1,name2\` — exact name lookup (comma-separated). Use when you know the tool names.
- keywords (e.g. "web search") — fuzzy match against name + description. Max ${MAX_KEYWORD_RESULTS} results.

Available deferred tools: ${nameList}`

  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description,
    isConcurrencySafe: () => true,
    // Not read-only: what it finds becomes callable, so a mode that only
    // offers read-only tools must not offer this one.
    outputSchema: ToolSearchOutputSchema,
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: (output as ToolSearchOutput).text,
      }
    },
    create(_cwd: string, _context: ToolContext) {
      return tool({
        description,
        inputSchema: z.object({
          query: z
            .string()
            .describe(
              'Either "select:name1,name2" for exact lookup, or keywords for search.',
            ),
        }),
        execute: async ({ query }: { query: string }) => {
          const wrap = (
            text: string,
            matches: ToolSearchOutput['matches'] = [],
          ) => ({
            data: { text, query, matches } satisfies ToolSearchOutput,
          })
          const trimmed = query.trim()
          const selectNames = parseSelectNames(trimmed, index)

          if (selectNames) {
            const names = selectNames
            const found: string[] = []
            const notFound: string[] = []
            const details: string[] = []
            const matches: ToolSearchOutput['matches'] = []

            for (const name of names) {
              const entry = index.get(name)
              if (entry) {
                found.push(name)
                details.push(`- ${entry.name}: ${entry.description}`)
                matches.push({
                  name: entry.name,
                  description: entry.description,
                })
              } else {
                notFound.push(name)
              }
            }

            const parts: string[] = []
            if (found.length > 0) {
              parts.push(
                `Loaded ${found.length} tool(s). You can now use them:\n${details.join('\n')}`,
              )
            }
            if (notFound.length > 0) {
              parts.push(
                `Not found: ${notFound.join(', ')}. Available: ${nameList}`,
              )
            }
            return wrap(parts.join('\n\n') || 'No tools matched.', matches)
          }

          // Keyword search
          const keywords = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
          if (keywords.length === 0) {
            return wrap(`Empty query. Available deferred tools: ${nameList}`)
          }

          const hits = deferredDefs
            .filter(d => matchKeyword(d, keywords))
            .slice(0, MAX_KEYWORD_RESULTS)

          if (hits.length === 0) {
            return wrap(`No matches for "${trimmed}". Available: ${nameList}`)
          }

          const details = hits
            .map(d => `- ${d.name}: ${d.description}`)
            .join('\n')
          return wrap(
            `Found ${hits.length} tool(s):\n${details}`,
            hits.map(d => ({ name: d.name, description: d.description })),
          )
        },
      })
    },
  }
}
