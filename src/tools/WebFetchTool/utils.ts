/**
 * WebFetch internals.
 *
 * Covers: URL validation, manual redirect handling (same-host only), 15-minute
 * LRU cache, turndown HTML→markdown, binary persistence, secondary-model
 * distillation of the fetched markdown.
 *
 * Deliberately NOT ported: the `api.anthropic.com/api/web/domain_info`
 * blocklist preflight and the egress-proxy error mapping -- both depend on
 * Anthropic-side infrastructure we have no equivalent for.
 */
import axios, { type AxiosResponse } from 'axios'
import * as fs from 'fs'
import * as path from 'path'
import { generateText } from 'ai'
import { LRUCache } from 'lru-cache'
import { getScratchDataDir, getSessionDataDir } from '../../session/paths.js'
import type { IProvider } from '../../services/llm/types.js'
import { isPreapprovedHost } from './preapproved.js'
import { makeSecondaryModelPrompt } from './prompt.js'

// Cache for storing fetched URL content
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// Cache with 15-minute TTL and 50MB size limit
// LRUCache handles automatic expiration and eviction
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
}

// Lazy singleton -- defers the turndown import until the first HTML fetch, and
// reuses one instance across calls (construction builds 15 rule objects;
// .turndown() is stateless).
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

export async function htmlToMarkdown(html: string): Promise<string> {
  return (await getTurndownService()).turndown(html)
}

// Long URLs are legitimate (JWT-signed cloud URLs), so this cap is generous.
const MAX_URL_LENGTH = 2000

// Resource consumption control: cap the response body so a single request
// cannot exhaust memory.
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// Timeout for the main HTTP fetch request (60 seconds).
// Prevents hanging indefinitely on slow/unresponsive servers.
const FETCH_TIMEOUT_MS = 60_000

// Cap same-host redirect hops. Without this a malicious server can return
// a redirect loop (/a → /b → /a …) and the per-request FETCH_TIMEOUT_MS
// resets on every hop, hanging the tool until user interrupt. 10 matches
// common client defaults (axios=5, follow-redirects=21, Chrome=20).
const MAX_REDIRECTS = 10

// Truncate to not spend too many tokens
export const MAX_MARKDOWN_LENGTH = 100_000

const WEB_FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; ai-coding-agent/1.0)'

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // We don't need to check protocol here, as we'll upgrade http to https when making the request

  // As long as we aren't aiming to support cookies or internal domains,
  // we should block URLs with usernames/passwords too, even though these
  // seem exceedingly unlikely.
  if (parsed.username || parsed.password) {
    return false
  }

  // Initial filter that this isn't a privileged, company-internal URL
  // by checking that the hostname is publicly resolvable
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

/**
 * Check if a redirect is safe to follow
 * Allows redirects that:
 * - Add or remove "www." in the hostname
 * - Keep the origin the same but change path/query params
 * - Or both of the above
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // Now check hostname conditions
    // 1. Adding www. is allowed: example.com -> www.example.com
    // 2. Removing www. is allowed: www.example.com -> example.com
    // 3. Same host (with or without www.) is allowed: paths can change
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * Helper function to handle fetching URLs with custom redirect handling
 * Recursively follows redirects if they pass the redirectChecker function
 *
 * Redirects are not followed automatically: an open redirect on a trusted
 * domain would otherwise let an attacker point the fetch at a host the user
 * never approved.
 */
export type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }
  try {
    return await axios.get(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': WEB_FETCH_USER_AGENT,
      },
    })
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header', { cause: error })
      }

      // Resolve relative URLs against the original URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // Recursively follow the permitted redirect
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // Return redirect information to the caller
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

const BINARY_CONTENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/octet-stream': 'bin',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}

function binaryExtension(contentType: string): string | undefined {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return BINARY_CONTENT_TYPES[mime]
}

export function isBinaryContentType(contentType: string): boolean {
  return binaryExtension(contentType) !== undefined
}

/**
 * Save raw bytes under the session dir with a mime-derived extension so the
 * model can Read the file later (projects/ is a readable internal path).
 */
function persistBinaryContent(
  buffer: Buffer,
  contentType: string,
  persistId: string,
  sessionId: string | undefined,
): { filepath: string; size: number } | { error: string } {
  try {
    const ext = binaryExtension(contentType) ?? 'bin'
    const dir = path.join(
      sessionId ? getSessionDataDir(sessionId) : getScratchDataDir('webfetch'),
      'web-fetch',
    )
    fs.mkdirSync(dir, { recursive: true })
    const filepath = path.join(dir, `${persistId}.${ext}`)
    fs.writeFileSync(filepath, buffer)
    return { filepath, size: buffer.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[WebFetch] persistBinaryContent failed: ${message}`)
    return { error: message }
  }
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
  sessionId?: string,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // Check cache (LRUCache handles TTL automatically)
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let upgradedUrl = url
  try {
    const parsedUrl = new URL(url)
    // Upgrade http to https if needed
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn(`[WebFetch] URL parse failed for ${url}: ${message}`)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // Check if we got a redirect response
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // Release the axios-held ArrayBuffer copy; rawBuffer owns the bytes now.
  // This lets GC reclaim up to MAX_HTTP_CONTENT_LENGTH (10MB) before Turndown
  // builds its DOM tree (which can be 3-5x the HTML size).
  ;(response as { data: unknown }).data = null
  const contentTypeHeader = response.headers['content-type']
  const contentType =
    typeof contentTypeHeader === 'string' ? contentTypeHeader : ''

  // Binary content: save raw bytes to disk with a proper extension so the
  // model can inspect the file later. We still fall through to the utf-8
  // decode + secondary model path below -- for PDFs in particular the decoded
  // string has enough ASCII structure (/Title, text streams) to summarize,
  // and the saved file is a supplement rather than a replacement.
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = persistBinaryContent(
      rawBuffer,
      contentType,
      persistId,
      sessionId,
    )
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    markdownContent = await htmlToMarkdown(htmlContent)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // It's not HTML - just use it raw. The decoded string's UTF-8 byte
    // length equals rawBuffer.length (modulo U+FFFD replacement on invalid
    // bytes -- negligible for cache eviction accounting), so skip the O(n)
    // Buffer.byteLength scan.
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // Store the fetched content in cache. Note that it's stored under
  // the original URL, not the upgraded or redirected URL.
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // lru-cache requires positive integers; clamp to 1 for empty responses.
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

export async function applyPromptToMarkdown(opts: {
  prompt: string
  markdownContent: string
  provider: IProvider
  modelId: string
  signal?: AbortSignal
  isPreapprovedDomain: boolean
}): Promise<string> {
  // Truncate content to avoid "Prompt is too long" errors from the secondary model
  const truncatedContent =
    opts.markdownContent.length > MAX_MARKDOWN_LENGTH
      ? opts.markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : opts.markdownContent

  const modelPrompt = makeSecondaryModelPrompt(
    truncatedContent,
    opts.prompt,
    opts.isPreapprovedDomain,
  )

  const result = await generateText({
    model: opts.provider.chatModel(opts.modelId),
    prompt: modelPrompt,
    maxOutputTokens: 4096,
    abortSignal: opts.signal,
    ...opts.provider.streamTextExtras(),
  })

  // Bubble aborts up so the tool call reports an error instead of a summary
  // produced from a half-finished stream.
  if (opts.signal?.aborted) {
    const err = new Error('Request was aborted')
    err.name = 'AbortError'
    throw err
  }

  return result.text?.trim() || 'No response from model'
}
