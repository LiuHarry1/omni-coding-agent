/**
 * Micro projection lifetime and reactive tail-preserving compact tests.
 * Run: npx tsx src/tests/test-micro-reactive-compact.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { LanguageModel } from 'ai'
import type { AnyTool, IProvider, Message, RunAgentFn } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
} from '../core/messages/compact-boundary.js'
import {
  applyMicroCompactProjection,
  compactConversation,
  getActiveModelMessages,
  microCompact,
  rebaseMicroCompactState,
  resetMicroCompactState,
} from '../services/compact/index.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'
import {
  createSession,
  deleteSession,
  setSessionWorkspace,
} from '../session/index.js'
import {
  getCachedSessionLocation,
  getToolResultFilePath,
  sessionDataDir,
} from '../core/session-paths.js'
import { shouldAttemptReactiveCompaction } from '../core/query/run-step.js'
import { maxTokensOverrideFromError } from '../core/query/helpers.js'
import { applyCompactOutcome } from '../core/query/pre-turn.js'

function toolOutput(
  messages: Message[],
  toolCallId: string,
): string | undefined {
  for (const message of messages) {
    if (!isRoleMessage(message) || message.role !== 'tool') continue
    const part = message.content.find(item => item.toolCallId === toolCallId)
    if (part?.output.type === 'text') return part.output.value
  }
  return undefined
}

function provider(): IProvider {
  return {
    chatModel: () => ({}) as LanguageModel,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test-model',
    describe: () => 'test',
  }
}

async function testMicroProjectionLifetime(): Promise<void> {
  const sessionId = createSession({ cwd: process.cwd() }).id
  const originalOutput = 'x'.repeat(3_000)
  const history: Message[] = [
    { role: 'user', content: 'run it', uuid: 'u1' },
    {
      role: 'assistant',
      uuid: 'a1',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: BASH_TOOL_NAME,
          input: { command: 'echo test' },
        },
      ],
    },
    {
      role: 'tool',
      uuid: 't1',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: originalOutput },
        },
      ],
    },
  ]

  try {
    const compacted = microCompact(history, 0, sessionId)
    assert.equal(toolOutput(history, 'call-1'), originalOutput)
    assert.notEqual(toolOutput(compacted.messages, 'call-1'), originalOutput)

    const nextStep = [
      ...history,
      { role: 'user' as const, content: 'continue', uuid: 'u2' },
    ]
    const projected = applyMicroCompactProjection(nextStep, sessionId)
    assert.notEqual(toolOutput(projected, 'call-1'), originalOutput)
    assert.equal(toolOutput(nextStep, 'call-1'), originalOutput)

    const boundary = createCompactBoundaryMessage('auto', 10, 'u2')
    const afterBoundary = applyMicroCompactProjection(
      [...nextStep, boundary],
      sessionId,
    )
    assert.equal(toolOutput(afterBoundary, 'call-1'), originalOutput)
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
  }
}

async function testReactiveTailPreservesToolPair(): Promise<void> {
  const messages: Message[] = [
    { role: 'user', content: 'old request', uuid: 'old-u' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'old response' }],
      uuid: 'old-a',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tail-call',
          toolName: BASH_TOOL_NAME,
          input: { command: 'large output' },
        },
      ],
      uuid: 'tail-call-message',
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tail-call',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: 'z'.repeat(39_000) },
        },
      ],
      uuid: 'tail-result-message',
    },
    ...Array.from({ length: 5 }, (_, index): Message => ({
      role: 'user',
      content: `recent-${index}-${'r'.repeat(1_000)}`,
      uuid: `recent-${index}`,
    })),
  ]
  let summarizedUuids: string[] = []
  const runAgent: RunAgentFn = async (_prompt, options) => {
    summarizedUuids = (options.messages ?? []).map(
      message => message.uuid ?? '',
    )
    return '<summary>reactive summary</summary>'
  }
  const tools = { Bash: {} as AnyTool }
  const testProvider = provider()
  const result = await compactConversation(messages, 'test-model', {
    cwd: process.cwd(),
    todos: [],
    fileRestore: { maxFiles: 0, maxTokensPerFile: 0, totalBudget: 0 },
    provider: testProvider,
    runAgent,
    cacheSafeParams: {
      systemPrompt: 'test',
      tools,
      provider: testProvider,
      model: 'test-model',
      forkContextMessages: messages,
    },
    preserveRecentTail: {
      minTokens: 10_000,
      maxTokens: 40_000,
      minTextMessages: 5,
    },
  })

  assert.ok(result)
  assert.deepEqual(summarizedUuids, ['old-u', 'old-a'])
  assert.equal(result.messagesToKeep[0]?.uuid, 'tail-call-message')
  assert.equal(result.messagesToKeep[1]?.uuid, 'tail-result-message')
  assert.ok(result.messagesToKeep.some(message => message.uuid === 'recent-4'))
  assert.equal(
    result.appendMessages.some(message => message.uuid === 'tail-call-message'),
    false,
  )
  const boundary = result.appendMessages[0]
  assert.ok('compactMetadata' in boundary)
  assert.deepEqual(boundary.compactMetadata.preservedSegment, {
    headUuid: 'tail-call-message',
    anchorUuid: result.appendMessages[1]?.uuid,
    tailUuid: 'recent-4',
  })
  const active = getMessagesAfterCompactBoundary([
    ...messages,
    ...result.appendMessages,
  ])
  assert.ok(active.some(message => message.uuid === 'tail-call-message'))
  assert.ok(active.some(message => message.uuid === 'tail-result-message'))
}

function testMicroProjectionRebasesToPreservedTail(): void {
  const sessionId = createSession({ cwd: process.cwd() }).id
  const assistant: Message = {
    role: 'assistant',
    uuid: 'rebase-assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'rebase-call',
        toolName: BASH_TOOL_NAME,
        input: { command: 'large output' },
      },
    ],
  }
  const tool: Message = {
    role: 'tool',
    uuid: 'rebase-tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'rebase-call',
        toolName: BASH_TOOL_NAME,
        output: { type: 'text', value: 'p'.repeat(3_000) },
      },
    ],
  }
  const history: Message[] = [
    { role: 'user', content: 'run', uuid: 'rebase-user' },
    assistant,
    tool,
  ]
  try {
    const micro = microCompact(history, 0, sessionId)
    assert.notEqual(
      toolOutput(micro.messages, 'rebase-call'),
      'p'.repeat(3_000),
    )
    const boundary = createCompactBoundaryMessage('auto', 100, 'rebase-tool')
    boundary.uuid = 'rebase-boundary'
    boundary.compactMetadata.preservedSegment = {
      headUuid: 'rebase-assistant',
      anchorUuid: 'rebase-summary',
      tailUuid: 'rebase-tool',
    }
    const summary: Message = {
      role: 'user',
      content: 'summary',
      uuid: 'rebase-summary',
      isCompactSummary: true,
    }
    rebaseMicroCompactState(
      sessionId,
      [assistant, tool],
      [boundary, summary, assistant, tool],
    )
    const rebuilt = getActiveModelMessages(
      [...history, boundary, summary],
      sessionId,
    )
    assert.notEqual(toolOutput(rebuilt, 'rebase-call'), 'p'.repeat(3_000))

    const transcript = [...history]
    const active = applyCompactOutcome(
      transcript,
      {
        messages: [boundary, summary, assistant, tool],
        appendMessages: [boundary, summary],
        source: 'session_memory',
      },
      [],
      undefined,
      sessionId,
    )
    assert.ok(active.some(m => m.uuid === 'rebase-tool'))
    assert.notEqual(
      toolOutput(active, 'rebase-call'),
      'p'.repeat(3_000),
      'compact outcome view must keep micro-clears on the preserved tail',
    )
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
  }
}

function testMicroProjectionSurvivesRestart(): void {
  const sessionId = createSession({ cwd: process.cwd() }).id
  const raw = 'r'.repeat(3_000)
  const history: Message[] = [
    { role: 'user', content: 'run', uuid: 'restart-user' },
    {
      role: 'assistant',
      uuid: 'restart-assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'restart-call',
          toolName: BASH_TOOL_NAME,
          input: { command: 'large output' },
        },
      ],
    },
    {
      role: 'tool',
      uuid: 'restart-tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'restart-call',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: raw },
        },
      ],
    },
  ]
  try {
    microCompact(history, 0, sessionId)
    // Drops only the in-process copy, as a process restart would.
    resetMicroCompactState(sessionId)
    const reloaded = getActiveModelMessages(history, sessionId)
    assert.notEqual(
      toolOutput(reloaded, 'restart-call'),
      raw,
      'micro-clears must be reloaded from disk after a restart',
    )
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
  }
}

function testCorruptProjectionCanBeRetried(): void {
  const sessionId = createSession({ cwd: process.cwd() }).id
  const raw = 'c'.repeat(3_000)
  const history: Message[] = [
    { role: 'user', content: 'run', uuid: 'corrupt-user' },
    {
      role: 'assistant',
      uuid: 'corrupt-assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'corrupt-call',
          toolName: BASH_TOOL_NAME,
          input: { command: 'large output' },
        },
      ],
    },
    {
      role: 'tool',
      uuid: 'corrupt-tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'corrupt-call',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: raw },
        },
      ],
    },
  ]
  try {
    microCompact(history, 0, sessionId)
    const loc = getCachedSessionLocation(sessionId)
    assert.ok(loc)
    const statePath = path.join(
      sessionDataDir(loc, sessionId),
      'micro-compact.json',
    )
    const validState = fs.readFileSync(statePath, 'utf-8')
    resetMicroCompactState(sessionId)
    fs.writeFileSync(statePath, '{', 'utf-8')
    assert.equal(
      toolOutput(getActiveModelMessages(history, sessionId), 'corrupt-call'),
      raw,
    )

    fs.writeFileSync(statePath, validState, 'utf-8')
    assert.notEqual(
      toolOutput(getActiveModelMessages(history, sessionId), 'corrupt-call'),
      raw,
      'a failed parse must not permanently suppress reloads',
    )
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
  }
}

function testProjectionFollowsSessionRelocation(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-relocate-'))
  const oldCwd = path.join(root, 'old')
  const newCwd = path.join(root, 'new')
  fs.mkdirSync(oldCwd)
  fs.mkdirSync(newCwd)
  const sessionId = createSession({ cwd: oldCwd }).id
  const raw = 'm'.repeat(3_000)
  const history: Message[] = [
    { role: 'user', content: 'run', uuid: 'move-user' },
    {
      role: 'assistant',
      uuid: 'move-assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'move-call',
          toolName: BASH_TOOL_NAME,
          input: { command: 'large output' },
        },
      ],
    },
    {
      role: 'tool',
      uuid: 'move-tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'move-call',
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: raw },
        },
      ],
    },
  ]
  try {
    microCompact(history, 0, sessionId)
    const oldPath = getToolResultFilePath(sessionId, 'move-call')
    setSessionWorkspace(sessionId, { environmentId: 'local', cwd: newCwd })
    const newPath = getToolResultFilePath(sessionId, 'move-call')
    assert.notEqual(newPath, oldPath)
    assert.ok(fs.existsSync(newPath))

    resetMicroCompactState(sessionId)
    const output = toolOutput(
      getActiveModelMessages(history, sessionId),
      'move-call',
    )
    assert.ok(output?.includes(newPath))
    assert.equal(output?.includes(oldPath), false)
  } finally {
    resetMicroCompactState(sessionId)
    deleteSession(sessionId)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function testReactiveRetryLimit(): void {
  const contextError = new Error('context length exceeded')
  assert.equal(shouldAttemptReactiveCompaction(0, contextError), true)
  assert.equal(shouldAttemptReactiveCompaction(1, contextError), false)
  assert.equal(
    shouldAttemptReactiveCompaction(0, new Error('ordinary failure')),
    false,
  )
  const belowFloorOverflow = new Error(
    'input length and `max_tokens` exceed context limit: 197500 + 16384 > 200000',
  )
  assert.equal(maxTokensOverrideFromError(belowFloorOverflow), undefined)
  assert.equal(
    shouldAttemptReactiveCompaction(0, belowFloorOverflow),
    true,
    'an overflow below the output floor must fall back to compaction',
  )
}

await testMicroProjectionLifetime()
await testReactiveTailPreservesToolPair()
testMicroProjectionRebasesToPreservedTail()
testMicroProjectionSurvivesRestart()
testCorruptProjectionCanBeRetried()
testProjectionFollowsSessionRelocation()
testReactiveRetryLimit()
console.log('[PASS] micro projection persists until compact boundary')
console.log('[PASS] reactive full compact references a paired recent tail')
console.log('[PASS] micro projection rebases onto preserved tail')
console.log('[PASS] micro projection survives a process restart')
console.log('[PASS] corrupt micro projection can be retried')
console.log('[PASS] micro projection follows session relocation')
console.log('[PASS] reactive context retry is limited to once per step')
