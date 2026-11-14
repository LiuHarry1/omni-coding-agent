import { tool } from 'ai'
import { z } from 'zod'
import { truncate } from '../utils.js'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { WEB_SEARCH_TOOL_NAME } from '../../constants/tool_names.js'
import {
  executeWebSearch,
  getWebSearchProvider,
  webSearchProviderLabel,
  type WebSearchPayload,
} from './index.js'

const MAX_RESULTS = 10
const MAX_OUTPUT_CHARS = 12000

const EMPTY_RESULTS_WARNING =
  'Search returned zero results. Do NOT invent news, events, or facts. ' +
  'Tell the user the search found nothing and suggest retrying with a simpler query ' +
  'or switching WEB_SEARCH_PROVIDER (exa vs searxng).'

/** Model-facing text: prose + source reminder. Structured JSON stays in toolUseResult. */
function formatWebSearchOutput(
  output: WebSearchPayload & { warning?: string },
): string {
  const lines: string[] = [
    `Web search results for query: "${output.query}"`,
    '',
  ]

  if (output.warning) {
    lines.push(output.warning, '')
  }
  if (output.note) {
    lines.push(output.note, '')
  }
  if (output.content) {
    lines.push(output.content, '')
  }
  if (output.answers?.length) {
    lines.push('Answers:')
    for (const a of output.answers) lines.push(`- ${a}`)
    lines.push('')
  }

  const results = output.results ?? []
  if (results.length === 0 && !output.content) {
    lines.push('No results found.')
  } else {
    for (const hit of results) {
      const title = hit.title || hit.url || '(untitled)'
      lines.push(`${hit.rank}. ${title}`)
      if (hit.url) lines.push(`   ${hit.url}`)
      if (hit.snippet) lines.push(`   ${hit.snippet}`)
      lines.push('')
    }
  }

  if (output.suggestions?.length) {
    lines.push(`Suggestions: ${output.suggestions.join(', ')}`)
    lines.push('')
  }

  lines.push(
    'REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.',
  )

  return truncate(lines.join('\n').trim(), MAX_OUTPUT_CHARS)
}

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value!)))
}

function providerDescription(): string {
  const provider = getWebSearchProvider()
  if (provider === 'exa') {
    return (
      'Search the web for current or external information using Exa AI (MCP). ' +
      'Use this when project files are insufficient, information may be recent, or online references are needed. ' +
      'Returns titles, URLs, and snippets for citing sources.'
    )
  }
  return (
    'Search the web for current or external information using SearXNG. ' +
    'Use this when project files are insufficient, information may be recent, or online references are needed. ' +
    'Returns titles, URLs, snippets, engines, and optional suggestions.'
  )
}

export const definition: ToolDefinition = {
  name: WEB_SEARCH_TOOL_NAME,
  description: `Search the web (${getWebSearchProvider()})`,
  shouldDefer: true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  // Mode A — structured results for UI; prose + reminder for model
  outputSchema: z
    .object({
      query: z.string(),
      results: z.array(z.record(z.string(), z.unknown())).optional(),
      answers: z.array(z.string()).optional(),
      suggestions: z.array(z.string()).optional(),
      content: z.string().optional(),
      note: z.string().optional(),
      warning: z.string().optional(),
    })
    .passthrough(),
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatWebSearchOutput(output as WebSearchPayload),
    }
  },
  create() {
    return tool({
      description: providerDescription(),
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .optional()
          .describe('Maximum number of results to return. Default 5, max 10.'),
        language: z
          .string()
          .optional()
          .describe(
            "Optional SearXNG language code, e.g. 'en', 'zh-CN' (SearXNG only).",
          ),
        categories: z
          .string()
          .optional()
          .describe(
            "Optional SearXNG categories, e.g. 'general', 'it', 'science' (SearXNG only).",
          ),
        time_range: z
          .enum(['day', 'week', 'month', 'year'])
          .optional()
          .describe('Optional time range filter (SearXNG only).'),
      }),
      execute: async (args: {
        query: string
        max_results?: number
        language?: string
        categories?: string
        time_range?: 'day' | 'week' | 'month' | 'year'
      }) => {
        const maxResults = asPositiveInt(args.max_results, 5)
        const output = await executeWebSearch(args, maxResults)

        if (typeof output === 'string') {
          return output
        }

        const data: WebSearchPayload & { warning?: string } = { ...output }
        if (data.results.length === 0 && !data.content) {
          data.warning = EMPTY_RESULTS_WARNING
        }
        return { data } satisfies DualChannelToolResult<WebSearchPayload>
      },
    })
  },
}

export { getWebSearchProvider, webSearchProviderLabel }
