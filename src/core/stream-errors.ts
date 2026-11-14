/**
 * Error classification for stream/API failures.
 * Separated from compaction — used by the agent retry loop.
 */

export function streamErrorText(err: unknown): string {
  if (!err) return ''
  const parts: string[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown, depth: number): void => {
    if (value == null || depth > 5 || seen.has(value)) return
    if (typeof value === 'object') seen.add(value)
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (value instanceof Error) {
      parts.push(value.message)
      walk(value.cause, depth + 1)
      return
    }
    if (typeof value === 'object') {
      const e = value as { message?: string; cause?: unknown }
      if (typeof e.message === 'string') parts.push(e.message)
      walk(e.cause, depth + 1)
    }
  }
  walk(err, 0)
  return parts.join(' ')
}

export type MaxTokensContextOverflow = {
  inputTokens: number
  maxTokens: number
  contextLimit: number
  /**
   * `inputTokens` is only a floor (`contextLimit - maxTokens + 1`), not the
   * real prompt size, so it cannot size a smaller max_tokens.
   */
  inputIsLowerBound?: boolean
}

/**
 * Parse provider errors where input + `max_tokens` exceeds the context limit.
 * Anthropic: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
 * LiteLLM:  "maximum context length is 262144 ... requested 128000 output tokens
 *            ... prompt contains at least 134145 input tokens"
 * vLLM behind LiteLLM reports "at least" as `limit - max_tokens + 1` whatever
 * the real prompt size is.
 */
export function parseMaxTokensContextOverflowError(
  err: unknown,
): MaxTokensContextOverflow | undefined {
  const msg = streamErrorText(err)
  if (!msg) return undefined

  const anthropic = msg.match(
    /input length and [`']?max_tokens[`']? exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i,
  )
  if (anthropic?.[1] && anthropic[2] && anthropic[3]) {
    const inputTokens = parseInt(anthropic[1], 10)
    const maxTokens = parseInt(anthropic[2], 10)
    const contextLimit = parseInt(anthropic[3], 10)
    if (
      Number.isFinite(inputTokens) &&
      Number.isFinite(maxTokens) &&
      Number.isFinite(contextLimit)
    ) {
      return { inputTokens, maxTokens, contextLimit }
    }
  }

  const litellm = msg.match(
    /maximum context length is (\d+)[\s\S]*?requested (\d+) output tokens[\s\S]*?prompt contains (at least )?(\d+) input tokens/i,
  )
  if (litellm?.[1] && litellm[2] && litellm[4]) {
    const contextLimit = parseInt(litellm[1], 10)
    const maxTokens = parseInt(litellm[2], 10)
    const inputTokens = parseInt(litellm[4], 10)
    if (
      Number.isFinite(inputTokens) &&
      Number.isFinite(maxTokens) &&
      Number.isFinite(contextLimit)
    ) {
      const inputIsLowerBound =
        !!litellm[3] && inputTokens + maxTokens === contextLimit + 1
      return {
        inputTokens,
        maxTokens,
        contextLimit,
        ...(inputIsLowerBound ? { inputIsLowerBound } : {}),
      }
    }
  }

  return undefined
}

/**
 * Heuristic: did this error come from the model rejecting the prompt as
 * too long? Covers OpenAI, Anthropic (413), Gemini, and proxy variants.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err) return false
  if (parseMaxTokensContextOverflowError(err)) return true
  const e = err as {
    statusCode?: number
    status?: number
    message?: string
    cause?: { message?: string }
  }
  const status = e.statusCode ?? e.status
  if (status === 413) return true
  const msg = streamErrorText(err).toLowerCase()
  // Rate-limit errors from gateways often mention tokens too ("too many
  // tokens per minute", "token limit exceeded") — those need a retry/backoff,
  // NOT compaction. Misclassifying them fires a full LLM summarization on
  // every throttled turn.
  if (
    status === 429 ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit')
  ) {
    return false
  }
  return (
    msg.includes('context length') ||
    msg.includes('context_length') ||
    msg.includes('context window') ||
    msg.includes('prompt is too long') ||
    msg.includes('prompt too long') ||
    msg.includes('maximum context') ||
    msg.includes('too many tokens') ||
    msg.includes('token count exceeds') ||
    msg.includes('token limit')
  )
}

/**
 * Heuristic: did the request fail because the upstream socket was closed
 * mid-flight (proxy timeout, ECONNRESET, undici "terminated", flaky 5xx)?
 * For these the right move is to retry the same request, not to compact.
 */
/** The endpoint refused the request itself (400/422), not its size or rate. */
export function isInvalidRequestError(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number } | null | undefined
  const status = e?.statusCode ?? e?.status
  return status === 400 || status === 422
}

/**
 * The provider is over capacity for this model (Anthropic 529
 * `overloaded_error`, or a gateway's wording of the same).
 */
export function isOverloadedError(err: unknown): boolean {
  if (!err) return false
  let current: unknown = err
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as {
      statusCode?: number
      status?: number
      lastError?: unknown
      cause?: unknown
    }
    if ((e.statusCode ?? e.status) === 529) return true
    current = e.lastError ?? e.cause
  }
  return streamErrorText(err).toLowerCase().includes('overloaded')
}

/**
 * How many failed requests one surfaced error stands for: the SDK retries a
 * request before giving up and reports every attempt on its retry error.
 */
export function failedAttemptCount(err: unknown): number {
  const attempts = (err as { errors?: unknown } | null)?.errors
  return Array.isArray(attempts) && attempts.length > 0 ? attempts.length : 1
}

export function isTransientStreamError(err: unknown): boolean {
  if (!err) return false
  if (isOverloadedError(err)) return true
  const e = err as {
    statusCode?: number
    status?: number
    code?: string
    message?: string
    cause?: { message?: string; code?: string }
  }
  const status = e.statusCode ?? e.status
  if (status === 502 || status === 503 || status === 504) return true
  // Rate limits are retryable-with-backoff, never compactable (see
  // isContextLengthError above).
  if (status === 429) return true
  const code = e.code ?? e.cause?.code ?? ''
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true
  }
  const msg = ((e.message ?? '') + ' ' + (e.cause?.message ?? '')).toLowerCase()
  return (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('terminated') ||
    msg.includes('other side closed') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset') ||
    msg.includes('network error') ||
    msg.includes('fetch failed') ||
    msg.includes('no output generated')
  )
}
