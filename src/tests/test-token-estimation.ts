/**
 * Rough token estimation ratios (bytes-per-token by file type / tool).
 * Run: npx tsx src/tests/test-token-estimation.ts
 */
import assert from 'node:assert/strict'
import {
  bytesPerTokenForFileType,
  bytesPerTokenForToolResult,
  roughTokenCountEstimation,
  roughTokenCountEstimationForFileType,
} from '../services/tokenEstimation.js'
import { estimateMessageTokens } from '../services/compact/tokens.js'
import type { Message } from '../core/types.js'

function toolMessage(toolName: string, value: string): Message {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName,
        output: { type: 'text', value },
      },
    ],
  } as Message
}

function testRatios(): void {
  assert.equal(roughTokenCountEstimation('x'), 1)
  assert.equal(roughTokenCountEstimation('x'.repeat(5)), 2)
  assert.equal(roughTokenCountEstimation('x'.repeat(400)), 100)
  assert.equal(roughTokenCountEstimation('x'.repeat(400), 2), 200)
  assert.equal(bytesPerTokenForFileType('json'), 2)
  assert.equal(bytesPerTokenForFileType('jsonl'), 2)
  assert.equal(bytesPerTokenForFileType('ts'), 4)
  assert.equal(
    roughTokenCountEstimationForFileType('x'.repeat(400), 'json'),
    200,
  )
  assert.equal(bytesPerTokenForToolResult('browser_snapshot'), 2)
  assert.equal(bytesPerTokenForToolResult('browser_cdp'), 2)
  assert.equal(bytesPerTokenForToolResult('Bash'), 4)
}

function testToolResultEstimate(): void {
  const body = 'x'.repeat(32_000)
  assert.equal(
    estimateMessageTokens(toolMessage('browser_click', body)),
    16_000,
  )
  assert.equal(estimateMessageTokens(toolMessage('Bash', body)), 8_000)
}

testRatios()
testToolResultEstimate()
console.log('[PASS] bytes-per-token ratios follow file type and tool')
console.log('[PASS] browser tool results are estimated at 2 bytes/token')
