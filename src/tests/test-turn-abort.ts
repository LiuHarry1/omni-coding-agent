/**
 * Tests for interrupt + turn abort controller.
 */
import assert from 'node:assert/strict'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  TOOL_INTERRUPT_RESULT,
  appendUserInterruption,
  commitPartialStreamToHistory,
  createUserInterruptionMessage,
  finalizeInterruptedTurn,
  isInterruptMessage,
  missingToolResultsForAssistant,
} from '../utils/interrupt.js'
import {
  abortTurn,
  clearTurnAbort,
  registerTurnAbort,
  isTurnAborted,
} from '../core/turn-abort-registry.js'
import {
  abortAllToolsForSession,
  clearToolAbort,
  registerToolAbort,
} from '../core/tool-abort-registry.js'
import { createChildAbortController } from '../utils/abortController.js'
import { executeOneTool } from '../services/tools/tool_execution.js'
import type { WireEmitter } from '../core/wire-emitter.js'
import type { Message } from '../core/types.js'

function mockWire(): WireEmitter & {
  results: string[]
  interruptedCalls: Array<{ tool_use?: boolean; text?: string }>
} {
  const results: string[] = []
  const interruptedCalls: Array<{ tool_use?: boolean; text?: string }> = []
  return {
    results,
    interruptedCalls,
    emit() {},
    stepStart() {},
    textDelta() {},
    thinking() {},
    toolCall() {},
    toolResult(msg: { result?: string }) {
      results.push(String(msg.result ?? ''))
    },
    done() {},
    error() {},
    finish() {},
    interrupted(input: { tool_use?: boolean; text?: string }) {
      interruptedCalls.push(input)
    },
  } as unknown as WireEmitter & {
    results: string[]
    interruptedCalls: Array<{ tool_use?: boolean; text?: string }>
  }
}

async function testInterruptConstants() {
  const msg = createUserInterruptionMessage({ toolUse: false })
  assert.equal(msg.content, INTERRUPT_MESSAGE)
  assert.equal(isInterruptMessage(msg), true)
  assert.equal(
    createUserInterruptionMessage({ toolUse: true }).content,
    INTERRUPT_MESSAGE_FOR_TOOL_USE,
  )
  console.log('ok interrupt markers')
}

async function testSkipInterruptReason() {
  const wire = mockWire()
  const messages: Message[] = [{ role: 'user', content: 'hi', uuid: 'u1' }]
  const out = appendUserInterruption(messages, wire, {
    reason: 'interrupt',
  })
  assert.equal(out, undefined)
  assert.equal(messages.length, 1)
  assert.equal(wire.interruptedCalls.length, 0)
  console.log('ok skip interrupt marker for reason=interrupt')
}

async function testCommitPartialUsesMissingHelper() {
  const wire = mockWire()
  const messages: Message[] = [
    { role: 'user', content: 'do stuff', uuid: 'u1' },
  ]
  commitPartialStreamToHistory(
    messages,
    {
      text: 'Partial',
      toolCalls: [{ toolCallId: 'a', toolName: 'Read', input: { path: 'x' } }],
      toolResults: [],
      completedCleanly: false,
      aborted: true,
    },
    wire,
  )
  assert.equal(messages.length, 3)
  assert.match(wire.results[0]!, /Interrupted by user/)
  appendUserInterruption(messages, wire, { toolUse: false })
  assert.equal(isInterruptMessage(messages[3]!), true)
  console.log('ok commit partial + interrupt')
}

async function testMissingToolResults() {
  const parts = missingToolResultsForAssistant([
    { type: 'tool-call', toolCallId: 't1', toolName: 'Bash', input: {} },
  ])
  assert.equal(parts[0]!.isError, true)
  console.log('ok missing tool_results helper')
}

async function testFinalizeBareUserTurn() {
  const wire = mockWire()
  const messages: Message[] = [{ role: 'user', content: 'hello', uuid: 'u1' }]
  assert.equal(
    finalizeInterruptedTurn(messages, wire, { toolUse: false }),
    INTERRUPT_MESSAGE,
  )
  console.log('ok finalize bare user turn')
}

async function testTurnAbortWithReason() {
  const sid = 'sess-abort-1'
  const ac = registerTurnAbort(sid)
  assert.equal(isTurnAborted(sid), false)
  assert.equal(abortTurn(sid, 'user-cancel'), true)
  assert.equal(ac.signal.aborted, true)
  assert.equal(ac.signal.reason, 'user-cancel')
  clearTurnAbort(sid, ac)
  assert.equal(abortTurn(sid), false)
  console.log('ok turn abort reason')
}

async function testChildAbortController() {
  const parent = new AbortController()
  const child = createChildAbortController(parent)
  assert.equal(child.signal.aborted, false)
  parent.abort('user-cancel')
  assert.equal(child.signal.aborted, true)
  assert.equal(child.signal.reason, 'user-cancel')
  console.log('ok child abort controller')
}

async function testAbortAllToolsForSession() {
  const sid = 'sess-tools-1'
  const parent = new AbortController()
  const s1 = registerToolAbort(sid, 't1', parent.signal)
  abortAllToolsForSession(sid)
  assert.equal(s1.aborted, true)
  clearToolAbort(sid, 't1')
  console.log('ok abortAllToolsForSession with parent link')
}

async function testCancelledRemainingTools() {
  const wire = mockWire()
  const ac = new AbortController()
  let started = 0
  const tools = {
    slow: {
      execute: async (
        _input: unknown,
        opts?: { abortSignal?: AbortSignal },
      ) => {
        started += 1
        assert.ok(opts?.abortSignal, 'tool receives abortSignal')
        if (started === 1) ac.abort()
        return 'ok-1'
      },
    },
    later: {
      execute: async () => 'should-not-run',
    },
  }
  const toolCalls = [
    { toolCallId: 'a', toolName: 'slow', input: {} },
    { toolCallId: 'b', toolName: 'later', input: {} },
  ]
  const results = []
  for (const tc of toolCalls) {
    if (ac.signal.aborted) {
      wire.toolResult({
        tool_use_id: tc.toolCallId,
        result: TOOL_INTERRUPT_RESULT,
        is_error: true,
      })
      results.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: TOOL_INTERRUPT_RESULT,
        isError: true,
      })
      continue
    }
    results.push(
      await executeOneTool(
        tc,
        tools as never,
        wire,
        'sess-run-tools',
        undefined,
        ac.signal,
      ),
    )
  }
  assert.equal(results.length, 2)
  assert.equal(results[0]!.result, 'ok-1')
  assert.equal(results[1]!.result, TOOL_INTERRUPT_RESULT)
  assert.equal(started, 1)
  console.log('ok tool abortSignal + cancelled remaining')
}

await testInterruptConstants()
await testSkipInterruptReason()
await testMissingToolResults()
await testCommitPartialUsesMissingHelper()
await testFinalizeBareUserTurn()
await testTurnAbortWithReason()
await testChildAbortController()
await testAbortAllToolsForSession()
await testCancelledRemainingTools()
console.log('\nall interrupt / turn-abort tests passed')
