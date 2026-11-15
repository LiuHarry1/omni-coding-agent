/**
 * openai-compatible SSE tool_calls rewrite — first delta per index must have
 * id + function.name (AI SDK invariant). Run:
 *   npx tsx src/tests/test-normalize-openai-tool-stream.ts
 */
import assert from 'node:assert/strict'
import {
  createNormalizedOpenAICompatibleFetch,
  createOpenAIToolCallNormalizeTransform,
  normalizeOpenAICompatibleSse,
} from '../services/llm/strategies/normalize-openai-tool-stream.js'

type ToolCallDelta = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

type ParsedTool = {
  id: string
  name: string
  arguments: string
}

/** Mirrors @ai-sdk/openai-compatible first-chunk checks. */
function parseLikeAiSdk(sse: string): ParsedTool[] {
  const toolCalls: Array<ParsedTool | undefined> = []
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trimStart()
    if (!payload || payload === '[DONE]') continue
    const value = JSON.parse(payload) as {
      choices?: Array<{ delta?: { tool_calls?: ToolCallDelta[] } }>
    }
    const calls = value.choices?.[0]?.delta?.tool_calls
    if (!calls) continue
    for (const toolCallDelta of calls) {
      const index = toolCallDelta.index as number
      if (toolCalls[index] == null) {
        if (toolCallDelta.type != null && toolCallDelta.type !== 'function') {
          throw new Error(`Expected 'function' type.`)
        }
        if (toolCallDelta.id == null) {
          throw new Error(`Expected 'id' to be a string.`)
        }
        if (toolCallDelta.function?.name == null) {
          throw new Error(`Expected 'function.name' to be a string.`)
        }
        toolCalls[index] = {
          id: toolCallDelta.id,
          name: toolCallDelta.function.name,
          arguments: toolCallDelta.function.arguments ?? '',
        }
        continue
      }
      const toolCall = toolCalls[index]!
      if (toolCallDelta.function?.arguments != null) {
        toolCall.arguments += toolCallDelta.function.arguments
      }
    }
  }
  return toolCalls.filter((t): t is ParsedTool => t != null)
}

function sse(events: unknown[]): string {
  return (
    events.map(e => `data: ${JSON.stringify(e)}`).join('\n') +
    '\n\ndata: [DONE]\n'
  )
}

function chunk(
  toolCalls: ToolCallDelta[],
  extra?: { content?: string; finish_reason?: string | null },
) {
  return {
    choices: [
      {
        delta: {
          ...(extra?.content != null ? { content: extra.content } : {}),
          tool_calls: toolCalls,
        },
        finish_reason: extra?.finish_reason ?? null,
      },
    ],
  }
}

function assertThrowsFirstChunk(raw: string): void {
  assert.throws(() => parseLikeAiSdk(raw), /Expected '(id|function\.name)'/)
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a.pdf"}' },
      },
    ]),
  ])
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.name, 'Read')
  assert.equal(parsed[0]?.arguments, '{"path":"a.pdf"}')
  console.log('[ok] legal first chunk unchanged')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"' },
      },
    ]),
    chunk([{ index: 0, function: { arguments: 'a.pdf"}' } }]),
  ])
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed[0]?.arguments, '{"path":"a.pdf"}')
  console.log('[ok] same-index nameless continuation stays legal')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a.pdf"}' },
      },
    ]),
    chunk([{ function: { arguments: '{"path":"b.jpg"}' } }]),
  ])
  assertThrowsFirstChunk(raw)
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.arguments, '{"path":"a.pdf"}{"path":"b.jpg"}')
  console.log('[ok] omitted index attaches to last opened tool')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a.pdf"}' },
      },
    ]),
    chunk([{ index: 1, function: { arguments: '{"path":"' } }]),
    chunk([
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'Read', arguments: 'b.jpg"}' },
      },
    ]),
  ])
  assertThrowsFirstChunk(raw)
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]?.id, 'call_a')
  assert.equal(parsed[0]?.arguments, '{"path":"a.pdf"}')
  assert.equal(parsed[1]?.id, 'call_b')
  assert.equal(parsed[1]?.name, 'Read')
  assert.equal(parsed[1]?.arguments, '{"path":"b.jpg"}')
  console.log('[ok] parallel tool: args-first then name is buffered')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a.pdf"}' },
      },
      { index: 1, function: { arguments: '{"path":"' } },
    ]),
    chunk([
      {
        index: 1,
        id: 'call_b',
        function: { name: 'Read', arguments: 'b.jpg"}' },
      },
    ]),
  ])
  assertThrowsFirstChunk(raw)
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1]?.arguments, '{"path":"b.jpg"}')
  console.log('[ok] same event: complete tool 0 + incomplete tool 1')
}

{
  const raw = sse([
    chunk([{ index: 1, function: { arguments: '{"x":' } }], {
      content: 'working',
    }),
    chunk([
      {
        index: 1,
        id: 'call_b',
        function: { name: 'Read', arguments: '1}' },
      },
    ]),
  ])
  const normalized = normalizeOpenAICompatibleSse(raw)
  assert.match(normalized, /working/)
  const parsed = parseLikeAiSdk(normalized)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.arguments, '{"x":1}')
  console.log('[ok] content is forwarded while tool start is held')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        function: { name: 'Read', arguments: '{"path":"a"}' },
      },
    ]),
  ])
  assert.throws(() => parseLikeAiSdk(raw), /Expected 'id'/)
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.name, 'Read')
  assert.match(parsed[0]?.id ?? '', /^call_norm_0_/)
  console.log('[ok] name without id synthesizes an id')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a"}' },
      },
    ]),
    chunk([{ index: 1, function: { arguments: '{"path":"orphan"}' } }]),
  ])
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.id, 'call_a')
  console.log(
    '[ok] nameless leftover at stream end is dropped, first tool kept',
  )
}

{
  const raw = sse([
    chunk([{ index: 0, id: 'call_a', function: { arguments: '{"p":"' } }]),
    chunk([{ index: 0, function: { name: 'Bash', arguments: 'x"}' } }]),
  ])
  assert.throws(() => parseLikeAiSdk(raw), /function\.name/)
  const parsed = parseLikeAiSdk(normalizeOpenAICompatibleSse(raw))
  assert.equal(parsed[0]?.name, 'Bash')
  assert.equal(parsed[0]?.id, 'call_a')
  assert.equal(parsed[0]?.arguments, '{"p":"x"}')
  console.log('[ok] id first, name later still emits one start')
}

{
  const events = [
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a.pdf"}' },
      },
    ]),
    chunk([{ index: 1, function: { arguments: '{"path":"' } }]),
    chunk([
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'Read', arguments: 'b.jpg"}' },
      },
    ]),
  ]
  const full = sse(events)
  const pieces = [full.slice(0, 40), full.slice(40, 90), full.slice(90)]
  const transform = createOpenAIToolCallNormalizeTransform()
  const writer = transform.writable.getWriter()
  const reader = transform.readable.getReader()
  const readAll = (async () => {
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += value
    }
    return out
  })()
  for (const piece of pieces) await writer.write(piece)
  await writer.close()
  const parsed = parseLikeAiSdk(await readAll)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1]?.arguments, '{"path":"b.jpg"}')
  console.log('[ok] TransformStream reassembles split SSE lines')
}

{
  const raw = sse([
    chunk([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"a.pdf"}' },
      },
    ]),
    chunk([{ index: 1, function: { arguments: '{"path":"' } }]),
    chunk([
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'Read', arguments: 'b.jpg"}' },
      },
    ]),
  ])
  const fetchImpl = createNormalizedOpenAICompatibleFetch(async () => {
    return new Response(raw, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  const res = await fetchImpl('http://litellm.local/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ stream: true, model: 'qwen' }),
  })
  const parsed = parseLikeAiSdk(await res.text())
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1]?.name, 'Read')
  console.log('[ok] fetch wrapper normalizes event-stream bodies')
}

console.log('[ok] normalize-openai-tool-stream')
