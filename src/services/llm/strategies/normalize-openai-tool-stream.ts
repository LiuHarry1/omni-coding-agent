/**
 * LiteLLM / Qwen / vLLM often stream parallel OpenAI tool_calls out of spec:
 * a new `index` arrives with only `function.arguments` (no `id` / `name`),
 * or later chunks omit `index` entirely.
 *
 * `@ai-sdk/openai-compatible` requires id + function.name on the *first*
 * delta of each index and throws otherwise. This rewrite buffers until that
 * start event can be synthesized — same invariant as Anthropic
 * `content_block_start` (name first, JSON deltas after). An index whose name
 * never arrives is unusable, so it is dropped with a warning at end of stream.
 */

type ToolCallDelta = {
  index?: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

type ChatChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown
      tool_calls?: ToolCallDelta[]
      [key: string]: unknown
    }
    finish_reason?: unknown
    [key: string]: unknown
  }>
  [key: string]: unknown
}

type OpenedTool = { id: string; name: string }
type PendingTool = { id?: string; name?: string; arguments: string }

function coerceIndex(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return Number(value)
  }
  return fallback
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class OpenAIToolCallNormalizer {
  private readonly opened = new Map<number, OpenedTool>()
  private readonly pending = new Map<number, PendingTool>()
  private lastIndex = 0
  private synthSeq = 0

  rewriteChunk(value: unknown): unknown | null {
    if (!value || typeof value !== 'object') return value
    const chunk = value as ChatChunk
    const choice = chunk.choices?.[0]
    if (!choice) return value

    const rawCalls = choice.delta?.tool_calls
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) return value

    const outgoing: ToolCallDelta[] = []
    for (const tc of rawCalls) {
      const emitted = this.absorb(tc)
      if (emitted) outgoing.push(emitted)
    }

    const next = cloneChunk(chunk)
    const nextDelta = next.choices?.[0]?.delta
    if (!nextDelta) return next
    if (outgoing.length > 0) {
      nextDelta.tool_calls = outgoing
      return next
    }

    // Every delta here is still buffered. Drop the event unless it also
    // carries payload the caller is waiting on, such as streamed content.
    delete nextDelta.tool_calls
    return hasPayloadBesidesToolCalls(nextDelta, choice) ? next : null
  }

  /** Indexes still buffered because `function.name` never arrived. */
  unresolvedIndexes(): number[] {
    return [...this.pending.keys()]
  }

  private absorb(tc: ToolCallDelta): ToolCallDelta | null {
    const index = coerceIndex(tc.index, this.lastIndex)
    this.lastIndex = index

    const id = nonEmptyString(tc.id)
    const name = nonEmptyString(tc.function?.name)
    const args =
      typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''

    const opened = this.opened.get(index)
    if (opened) {
      return {
        index,
        ...(id ? { id } : {}),
        ...(tc.type ? { type: tc.type } : {}),
        function: {
          ...(name ? { name } : {}),
          ...(args ? { arguments: args } : {}),
        },
      }
    }

    const pend = this.pending.get(index) ?? { arguments: '' }
    if (id) pend.id = id
    if (name) pend.name = name
    if (args) pend.arguments += args
    this.pending.set(index, pend)
    return this.emitStart(index, pend)
  }

  private emitStart(index: number, pend: PendingTool): ToolCallDelta | null {
    if (!pend.name) return null
    const id = pend.id ?? `call_norm_${index}_${++this.synthSeq}`
    this.pending.delete(index)
    this.opened.set(index, { id, name: pend.name })
    return {
      index,
      id,
      type: 'function',
      function: {
        name: pend.name,
        arguments: pend.arguments,
      },
    }
  }
}

function hasPayloadBesidesToolCalls(
  delta: { [key: string]: unknown },
  choice: { finish_reason?: unknown },
): boolean {
  if (choice.finish_reason != null && choice.finish_reason !== '') return true
  return Object.keys(delta).some(key => delta[key] != null)
}

function cloneChunk(chunk: ChatChunk): ChatChunk {
  return structuredClone(chunk)
}

/**
 * An index that never received a name cannot become a legal start event, so
 * it is dropped. Say so: this module exists because upstream providers
 * misbehave, and a silent drop would leave no trace of a new failure mode.
 */
function warnUnresolved(normalizer: OpenAIToolCallNormalizer): void {
  const dropped = normalizer.unresolvedIndexes()
  if (dropped.length === 0) return
  console.warn(
    `[openai-compatible] dropped ${dropped.length} tool_call delta(s) with no function.name (index ${dropped.join(', ')})`,
  )
}

/** Rewrite a complete SSE document (one or more `data:` events). */
export function normalizeOpenAICompatibleSse(text: string): string {
  const normalizer = new OpenAIToolCallNormalizer()
  return rewriteSseText(text, normalizer)
}

export function rewriteSseText(
  text: string,
  normalizer: OpenAIToolCallNormalizer,
): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const rewritten = rewriteSseLine(line, normalizer)
    if (rewritten !== null) out.push(rewritten)
  }
  warnUnresolved(normalizer)
  return out.join('\n')
}

export function rewriteSseLine(
  line: string,
  normalizer: OpenAIToolCallNormalizer,
): string | null {
  if (!line.startsWith('data:')) return line
  const payload = line.slice(5).trimStart()
  if (payload === '[DONE]') return line
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return line
  }
  const rewritten = normalizer.rewriteChunk(parsed)
  if (rewritten == null) return null
  if (rewritten === parsed) return line
  return `data: ${JSON.stringify(rewritten)}`
}

export function createOpenAIToolCallNormalizeTransform(): TransformStream<
  string,
  string
> {
  const normalizer = new OpenAIToolCallNormalizer()
  let carry = ''
  return new TransformStream({
    transform(chunk, controller) {
      carry += chunk
      carry = carry.replace(/\r\n/g, '\n')
      const parts = carry.split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) {
        const rewritten = rewriteSseLine(line, normalizer)
        if (rewritten !== null) controller.enqueue(`${rewritten}\n`)
      }
    },
    flush(controller) {
      if (carry.length > 0) {
        const rewritten = rewriteSseLine(carry, normalizer)
        if (rewritten !== null) controller.enqueue(`${rewritten}\n`)
        carry = ''
      }
      warnUnresolved(normalizer)
    },
  })
}

function requestWantsStream(init?: RequestInit): boolean {
  const body = init?.body
  if (typeof body !== 'string') return false
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

function shouldNormalizeResponse(
  response: Response,
  init?: RequestInit,
): boolean {
  if (!response.body || !response.ok) return false
  const ct = response.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) return true
  if (ct.includes('application/json')) return false
  return requestWantsStream(init)
}

export function createNormalizedOpenAICompatibleFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init)
    if (!shouldNormalizeResponse(response, init) || !response.body) {
      return response
    }
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createOpenAIToolCallNormalizeTransform())
      .pipeThrough(new TextEncoderStream())
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
