/**
 * Stream `error` parts must reach runStep's classifier instead of being
 * masked by the SDK's generic NoOutputGeneratedError.
 * Run: npx tsx src/tests/test-stream-error-surface.ts
 */
import assert from 'node:assert/strict'
import type { streamText } from 'ai'
import { consumeStream } from '../core/agent/streamConsumer.js'
import { noopWireEmitter, type WireEmitter } from '../core/wire-emitter.js'
import { isTransientStreamError } from '../core/stream-errors.js'
import { maxTokensOverrideFromError } from '../core/query/helpers.js'
import { shouldAttemptReactiveCompaction } from '../core/query/run-step.js'

const LITELLM_OVERFLOW =
  'litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: ' +
  "Custom_openaiException - This model's maximum context length is 262144 tokens. " +
  'However, you requested 16384 output tokens and your prompt contains at least 245761 input tokens, ' +
  'for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number ' +
  'of requested output tokens. (parameter=input_tokens, value=245761) model=qwen3.6-35b-a3b.'

function fakeStream(events: unknown[]): ReturnType<typeof streamText> {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e
    })(),
  } as unknown as ReturnType<typeof streamText>
}

function recordingWire(): { wire: WireEmitter; errors: string[] } {
  const errors: string[] = []
  const wire = new Proxy(noopWireEmitter, {
    get(target, prop) {
      if (prop === 'error') return (msg: string) => errors.push(msg)
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { wire, errors }
}

async function testEmptyStreamRethrowsOriginalError(): Promise<void> {
  const original = new Error(LITELLM_OVERFLOW)
  const { wire, errors } = recordingWire()
  const thrown = await consumeStream(
    fakeStream([{ type: 'start' }, { type: 'error', error: original }]),
    wire,
  ).then(
    () => undefined,
    (e: unknown) => e,
  )

  assert.equal(thrown, original)
  assert.deepEqual(errors, [], 'runStep owns the user-facing error')
  assert.equal(isTransientStreamError(thrown), false)
  // 245761 + 16384 = limit + 1: the "at least" figure is a floor, so shrinking
  // max_tokens cannot help -- go straight to reactive compaction.
  assert.equal(maxTokensOverrideFromError(thrown), undefined)
  assert.equal(shouldAttemptReactiveCompaction(0, thrown), true)
}

function testExactLiteLLMCountStillShrinks(): void {
  const exact = new Error(
    "This model's maximum context length is 262144 tokens. However, you requested " +
      '16384 output tokens and your prompt contains at least 250000 input tokens, ' +
      'for a total of at least 266384 tokens.',
  )
  assert.equal(maxTokensOverrideFromError(exact), 262144 - 250000 - 1000)
}

async function testPartialOutputKeepsResult(): Promise<void> {
  const { wire, errors } = recordingWire()
  const result = await consumeStream(
    fakeStream([
      { type: 'text-delta', id: 't1', text: 'partial' },
      { type: 'error', error: new Error('late upstream failure') },
    ]),
    wire,
  )

  assert.equal(result.text, 'partial')
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /late upstream failure/)
}

async function testIncompleteToolInputRethrowsOriginalError(): Promise<void> {
  const original = new Error(LITELLM_OVERFLOW)
  const { wire, errors } = recordingWire()
  const thrown = await consumeStream(
    fakeStream([
      { type: 'tool-input-start', id: 'call-1', toolName: 'Bash' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"command":' },
      { type: 'error', error: original },
    ]),
    wire,
  ).then(
    () => undefined,
    (e: unknown) => e,
  )

  assert.equal(thrown, original)
  assert.deepEqual(errors, [])
}

await testEmptyStreamRethrowsOriginalError()
await testIncompleteToolInputRethrowsOriginalError()
await testPartialOutputKeepsResult()
testExactLiteLLMCountStillShrinks()
console.log('[PASS] empty stream rethrows the original provider error')
console.log('[PASS] incomplete tool input rethrows the original provider error')
console.log(
  '[PASS] lower-bound overflow skips shrink; exact count still shrinks',
)
console.log(
  '[PASS] stream error after output is reported without dropping output',
)
