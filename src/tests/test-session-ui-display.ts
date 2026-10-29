/**
 * Visible composer text survives expanded skill/command persistence.
 * Run: npx tsx src/tests/test-session-ui-display.ts
 */
import assert from 'node:assert/strict'
import { buildUserMessage } from '../core/query/helpers.js'
import { sessionToUIMessages } from '../server/session-ui.js'
import type { Message } from '../core/types.js'

function displayedContent(message: Message): string | undefined {
  const ui = sessionToUIMessages([message]) as Array<{
    type: string
    content?: string
  }>
  return ui[0]?.content
}

const expanded = 'Base directory for this skill: /tmp/skills/review\n\nbody'
const persisted = buildUserMessage(
  expanded,
  undefined,
  false,
  undefined,
  '/review src',
)
assert.equal(persisted.displayContent, '/review src')
assert.equal(displayedContent(persisted), '/review src')

for (const baseDir of [
  '/home/user/.custom-agent/skills/review',
  '/home/user/plugins/example/skills/review',
  String.raw`C:\plugins\example\skills\review`,
]) {
  const legacy: Message = {
    role: 'user',
    content:
      `Base directory for this skill: ${baseDir}\n\nbody` +
      '\n\n---\n\nUser request: src',
  }
  assert.equal(displayedContent(legacy), '/review src')
}

const ordinary: Message = {
  role: 'user',
  content: 'Base directory for this skill: /tmp/not-skills/review\n\nbody',
}
assert.equal(displayedContent(ordinary), ordinary.content)

console.log('[PASS] displayContent preserves the original composer text')
console.log('[PASS] legacy skill display supports custom and plugin roots')
