import { randomUUID } from 'crypto'
import { tool } from 'ai'
import { z } from 'zod'
import {
  clearToolAbort,
  registerToolAbort,
} from '../../core/tool-abort-registry.js'
import type {
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import { TOOL_DESCRIPTION, WEB_FETCH_TOOL_NAME } from './prompt.js'
import {
  applyPromptToMarkdown,
  type FetchedContent,
  getURLMarkdownContent,
  isPreapprovedUrl,
  MAX_MARKDOWN_LENGTH,
} from './utils.js'

export type WebFetchOutput = {
  /** Size of the fetched content in bytes */
  bytes: number
  /** HTTP response code */
  code: number
  /** HTTP response code text */
  codeText: string
  /** Processed result from applying the prompt to the content */
  result: string
  /** Time taken to fetch and process the content */
  durationMs: number
  /** The URL that was fetched */
  url: string
}

export const WebFetchOutputSchema = z.object({
  bytes: z.number(),
  code: z.number(),
  codeText: z.string(),
  result: z.string(),
  durationMs: z.number(),
  url: z.string(),
})

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes} bytes`
}

function redirectStatusText(statusCode: number): string {
  switch (statusCode) {
    case 301:
      return 'Moved Permanently'
    case 308:
      return 'Permanent Redirect'
    case 307:
      return 'Temporary Redirect'
    default:
      return 'Found'
  }
}

/** Bridge the per-tool abort registry signal onto an `AbortController`. */
function controllerFromSignal(
  signal: AbortSignal | undefined,
): AbortController {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else
      signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}

export type WebFetchDependencies = {
  fetchContent?: typeof getURLMarkdownContent
  isPreapproved?: typeof isPreapprovedUrl
  applyPrompt?: typeof applyPromptToMarkdown
}

/** Dependency injection keeps network/model branches deterministic in tests. */
export function createWebFetchDefinition(
  dependencies: WebFetchDependencies = {},
): ToolDefinition {
  const fetchContent = dependencies.fetchContent ?? getURLMarkdownContent
  const isPreapproved = dependencies.isPreapproved ?? isPreapprovedUrl
  const applyPrompt = dependencies.applyPrompt ?? applyPromptToMarkdown

  return {
    name: WEB_FETCH_TOOL_NAME,
    description: 'Fetch a URL and process its content with a prompt',
    shouldDefer: true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    // Mode A -- model gets the processed result; UI gets size/status chrome.
    outputSchema: WebFetchOutputSchema,
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const { result } = output as WebFetchOutput
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: result,
      }
    },
    create(_cwd: string, context: ToolContext) {
      return tool({
        description: TOOL_DESCRIPTION,
        inputSchema: z.object({
          url: z.string().url().describe('The URL to fetch content from'),
          prompt: z
            .string()
            .describe('The prompt to run on the fetched content'),
        }),
        execute: async (
          args: { url: string; prompt: string },
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ): Promise<DualChannelToolResult<WebFetchOutput> | string> => {
          const { url, prompt } = args
          const start = Date.now()

          try {
            new URL(url)
          } catch {
            return `Error: Invalid URL "${url}". The URL provided could not be parsed.`
          }

          const sessionId = context.sessionId ?? ''
          const toolUseId = options?.toolCallId ?? randomUUID()
          const signal =
            options?.abortSignal ??
            (sessionId ? registerToolAbort(sessionId, toolUseId) : undefined)
          const abortController = controllerFromSignal(signal)

          try {
            const response = await fetchContent(
              url,
              abortController,
              context.sessionId,
            )

            // Check if we got a redirect to a different host
            if ('type' in response && response.type === 'redirect') {
              const statusText = redirectStatusText(response.statusCode)

              const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use ${WEB_FETCH_TOOL_NAME} again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`

              const data: WebFetchOutput = {
                bytes: Buffer.byteLength(message),
                code: response.statusCode,
                codeText: statusText,
                result: message,
                durationMs: Date.now() - start,
                url,
              }
              return { data }
            }

            const {
              content,
              bytes,
              code,
              codeText,
              contentType,
              persistedPath,
              persistedSize,
            } = response as FetchedContent

            const preapproved = isPreapproved(url)

            let result: string
            if (
              preapproved &&
              contentType.includes('text/markdown') &&
              content.length < MAX_MARKDOWN_LENGTH
            ) {
              result = content
            } else if (context.models) {
              result = await applyPrompt({
                prompt,
                markdownContent: content,
                provider: context.models.provider('small'),
                modelId: context.models.profile('small').model,
                signal: abortController.signal,
                isPreapprovedDomain: preapproved,
              })
            } else {
              // No request-scoped model registry (e.g. a bare tool harness):
              // hand back the markdown instead of failing the fetch.
              result =
                content.length > MAX_MARKDOWN_LENGTH
                  ? content.slice(0, MAX_MARKDOWN_LENGTH) +
                    '\n\n[Content truncated due to length...]'
                  : content
            }

            // Binary content (PDFs, etc.) was additionally saved to disk with a
            // mime-derived extension. Note it so the model can inspect the raw
            // file if the summary above isn't enough.
            if (persistedPath) {
              result += `\n\n[Binary content (${contentType}, ${formatFileSize(persistedSize ?? bytes)}) also saved to ${persistedPath}]`
            }

            const data: WebFetchOutput = {
              bytes,
              code,
              codeText,
              result,
              durationMs: Date.now() - start,
              url,
            }
            return { data }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              return `Error: web fetch aborted. URL: ${url}`
            }
            if (err instanceof Error && err.name === 'CanceledError') {
              return `Error: web fetch aborted. URL: ${url}`
            }
            const message = err instanceof Error ? err.message : String(err)
            return `Error: web fetch failed: ${message}. URL: ${url}`
          } finally {
            if (sessionId && !options?.abortSignal) {
              clearToolAbort(sessionId, toolUseId)
            }
          }
        },
      })
    },
  }
}

export const definition = createWebFetchDefinition()
