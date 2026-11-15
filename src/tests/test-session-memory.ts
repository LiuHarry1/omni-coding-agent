/**
 * Unit tests for session-memory keep-index + SM compact (no live LLM).
 * Run: npx tsx src/tests/test-session-memory.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type {
  AnyTool,
  IProvider,
  Message,
  RunAgentFn,
  SessionMemoryConfig,
} from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import { EventBus } from '../core/event-bus.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import {
  adjustIndexToPreserveToolPairs,
  adjustIndexToPreserveAssistantResponse,
  calculateMessagesToKeepIndex,
  ensureMessageUuid,
  evictSessionMemoryState,
  getSessionMemoryPath,
  getSessionMemoryStatePath,
  persistSessionMemoryState,
  trySessionMemoryCompaction,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
} from '../services/session-memory/index.js'
import {
  createCompactBoundaryMessage,
  isCompactBoundaryMessage,
} from '../core/messages/compact-boundary.js'
import { getSessionMemoryState } from '../services/session-memory/state.js'
import {
  repairSessionMemoryStructure,
  validateSessionMemoryStructure,
} from '../services/session-memory/template.js'
import {
  computeProjectKey,
  registerSessionLocation,
  unregisterSessionLocation,
} from '../session/paths.js'
import { resolveAgentHome } from '../utils/workspace/request-scope.js'
import { compactIfNeeded } from '../services/compact/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_ID = `sm-test-${randomUUID()}`
const SM_CONFIG: SessionMemoryConfig = {
  enabled: true,
  minimumTokensToInit: 1,
  minimumTokensBetweenUpdate: 1,
  toolCallsBetweenUpdates: 1,
  cacheSafe: true,
  modelTier: 'medium',
  compactMinTokens: 1,
  compactMaxTokens: 100_000,
  compactMinTextMessages: 1,
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`)
    process.exit(1)
  }
  console.log(`[PASS] ${msg}`)
}

function user(text: string): Message {
  return ensureMessageUuid({ role: 'user', content: text })
}

function assistantText(text: string): Message {
  return ensureMessageUuid({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })
}

function assistantTool(id: string, name = 'Bash'): Message {
  return ensureMessageUuid({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        input: {},
      },
    ],
  })
}

function toolResult(id: string, name = 'Bash'): Message {
  return ensureMessageUuid({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: name,
        output: { type: 'text', value: 'ok' },
      },
    ],
  })
}

async function main(): Promise<void> {
  registerSessionLocation(SESSION_ID, {
    projectKey: computeProjectKey(undefined, process.cwd()),
    agentHome: resolveAgentHome(),
  })

  // Tool-pair preservation: keep must not start mid tool-result without call.
  const msgs: Message[] = [
    user('hi'),
    assistantTool('t1'),
    toolResult('t1'),
    user('next'),
    assistantText('done'),
  ]
  const adjusted = adjustIndexToPreserveToolPairs(msgs, 2)
  assert(
    adjusted === 1,
    `adjustIndex pulls back to tool-call (got ${adjusted})`,
  )

  const fragmented: Message[] = [
    ensureMessageUuid({
      role: 'assistant',
      id: 'response-1',
      content: [{ type: 'reasoning', text: 'thinking' }],
    }),
    ensureMessageUuid({
      role: 'assistant',
      id: 'response-1',
      content: [{ type: 'text', text: 'answer' }],
    }),
    user('next'),
  ]
  assert(
    adjustIndexToPreserveAssistantResponse(fragmented, 1) === 0,
    'keep boundary does not split assistant response fragments',
  )

  const oldCall = assistantTool('before-boundary')
  const compactBoundary = createCompactBoundaryMessage('auto', 100)
  const crossBoundary: Message[] = [
    oldCall,
    compactBoundary,
    toolResult('before-boundary'),
  ]
  assert(
    adjustIndexToPreserveToolPairs(crossBoundary, 2) === 2,
    'tool-pair adjustment never crosses the latest compact boundary',
  )

  const keepCfg = {
    minTokens: 1,
    maxTokens: 100_000,
    minTextMessages: 1,
  }
  const last = msgs[msgs.length - 1]!
  const lastUuid = (last as { uuid?: string }).uuid!
  const start = calculateMessagesToKeepIndex(msgs, lastUuid, keepCfg)
  // Cursor at last → initially keep empty, then expand back for minTokens/minText.
  assert(
    start >= 0 && start < msgs.length,
    `cursor at last msg → expand keep into recent history (got ${start})`,
  )

  // Missing cursor → -1
  const missing = calculateMessagesToKeepIndex(msgs, 'no-such-id', keepCfg)
  assert(missing === -1, 'missing cursor returns -1')

  // Forward-trim when tail exceeds maxTokens
  const fat: Message[] = []
  for (let i = 0; i < 20; i++) {
    fat.push(
      ensureMessageUuid({
        role: 'user',
        content: 'x'.repeat(4000), // ~1000 tokens each by chars/4
      }),
    )
  }
  const trimmed = calculateMessagesToKeepIndex(fat, undefined, {
    minTokens: 1,
    maxTokens: 2500,
    minTextMessages: 1,
  })
  assert(
    trimmed > 0 && trimmed < fat.length,
    `forward-trim keep index under maxTokens (got ${trimmed})`,
  )

  // SM compact with filled notes
  const memPath = getSessionMemoryPath(SESSION_ID)
  fs.mkdirSync(path.dirname(memPath), { recursive: true })
  const filled = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
    '# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\n',
    '# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nWorking on session-memory tests.\n',
  )
  fs.writeFileSync(memPath, filled)

  const malformed = filled.replace('# Key results', 'undefined')
  const repaired = repairSessionMemoryStructure(malformed, filled)
  assert(!!repaired, 'repairs a model edit with a missing section header')
  assert(
    validateSessionMemoryStructure(repaired!),
    'repaired Session Memory preserves required structure',
  )
  assert(
    !repaired!.split('\n').some(line => line.trim() === 'undefined'),
    'repair removes a bare undefined edit artifact',
  )

  const state = getSessionMemoryState(SESSION_ID)
  state.lastSummarizedMessageId = (msgs[2] as { uuid?: string }).uuid

  const sm = await trySessionMemoryCompaction({
    messages: msgs,
    sessionId: SESSION_ID,
    config: SM_CONFIG,
    estimateTokens: () => 100,
  })
  assert(!!sm, 'SM compact succeeds with notes file')
  assert(sm!.source === 'session_memory', 'source is session_memory')
  assert(
    sm!.messages.some(
      m =>
        isRoleMessage(m) &&
        m.role === 'user' &&
        typeof m.content === 'string' &&
        !!m.isCompactSummary,
    ),
    'includes compact summary message',
  )
  assert(sm!.messagesToKeep.length > 0, 'preserves messagesToKeep')
  const smBoundary = sm!.appendMessages.find(isCompactBoundaryMessage)
  assert(!!smBoundary, 'SM compact appends a compact boundary')
  assert(
    !!smBoundary!.compactMetadata.preservedSegment,
    'SM boundary references the preserved pre-boundary tail',
  )
  const keptUuids = new Set(
    sm!.messagesToKeep.map(message =>
      'uuid' in message ? message.uuid : undefined,
    ),
  )
  assert(
    !sm!.appendMessages.some(
      message => 'uuid' in message && keptUuids.has(message.uuid),
    ),
    'SM append events do not physically duplicate preserved messages',
  )

  // An extract that outlives the wait must not disable SM compact: notes and
  // the cursor are published together, so the previous generation is usable.
  state.lastSummarizedMessageId = (msgs[2] as { uuid?: string }).uuid
  state.inFlight = true
  state.extractionStartedAt = Date.now()
  process.env.SM_EXTRACT_WAIT_TIMEOUT_MS = '10'
  let smInFlight: Awaited<ReturnType<typeof trySessionMemoryCompaction>> = null
  try {
    smInFlight = await trySessionMemoryCompaction({
      messages: msgs,
      sessionId: SESSION_ID,
      config: SM_CONFIG,
      estimateTokens: () => 100,
    })
  } finally {
    delete process.env.SM_EXTRACT_WAIT_TIMEOUT_MS
    state.inFlight = false
    state.extractionStartedAt = undefined
  }
  assert(
    smInFlight?.source === 'session_memory',
    'SM compact proceeds while an extract is still in flight',
  )
  assert(
    (smInFlight?.messagesToKeep.length ?? 0) > 0,
    'in-flight SM compact still preserves a tail',
  )

  // Manual semantics: plain /compact may use SM; steering forces Full.
  state.lastSummarizedMessageId = (msgs[2] as { uuid?: string }).uuid
  const provider: IProvider = {
    chatModel: () => ({}) as ReturnType<IProvider['chatModel']>,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test-model',
    describe: () => 'test',
  }
  const runAgent: RunAgentFn = async () =>
    '<summary>manually steered full summary</summary>'
  const compactTools = { Bash: {} as AnyTool }
  const plainManual = await compactIfNeeded(
    [...msgs],
    new EventBus(),
    noopWireEmitter,
    'test-model',
    process.cwd(),
    [],
    { force: true, trigger: 'manual', sessionMemory: SM_CONFIG },
    undefined,
    provider,
    SESSION_ID,
  )
  assert(
    plainManual.source === 'session_memory',
    'plain manual compact prefers Session Memory',
  )

  state.lastSummarizedMessageId = (msgs[2] as { uuid?: string }).uuid
  const steeredManual = await compactIfNeeded(
    [...msgs],
    new EventBus(),
    noopWireEmitter,
    'test-model',
    process.cwd(),
    [],
    {
      force: true,
      trigger: 'manual',
      instructions: 'focus on failures',
      sessionMemory: SM_CONFIG,
      runAgent,
      cacheSafeParams: {
        systemPrompt: 'main',
        tools: compactTools,
        provider,
        model: 'test-model',
        forkContextMessages: msgs,
      },
    },
    undefined,
    provider,
    SESSION_ID,
  )
  assert(
    steeredManual.source === 'full',
    'manual compact with instructions bypasses Session Memory',
  )

  fs.rmSync(memPath)
  const smFallback = await compactIfNeeded(
    [...msgs],
    new EventBus(),
    noopWireEmitter,
    'test-model',
    process.cwd(),
    [],
    {
      force: true,
      trigger: 'manual',
      sessionMemory: SM_CONFIG,
      runAgent,
      cacheSafeParams: {
        systemPrompt: 'main',
        tools: compactTools,
        provider,
        model: 'test-model',
        forkContextMessages: msgs,
      },
    },
    undefined,
    provider,
    SESSION_ID,
  )
  assert(
    smFallback.source === 'full',
    'missing Session Memory falls back to Full compact',
  )
  fs.writeFileSync(memPath, filled)

  // Memory Edit tool path lock
  const { createMemoryFileEditTool } =
    await import('../services/session-memory/memoryEditTool.js')
  const edit = createMemoryFileEditTool(memPath)
  const denied = await (
    edit as unknown as { execute: (a: unknown) => Promise<string> }
  ).execute({
    file_path: '/tmp/not-allowed.md',
    old_string: 'a',
    new_string: 'b',
  })
  assert(
    typeof denied === 'string' && denied.includes('only'),
    'Edit tool denies other paths',
  )
  const allowed = await (
    edit as unknown as { execute: (a: unknown) => Promise<string> }
  ).execute({
    file_path: memPath,
    old_string: 'Working on session-memory tests.',
    new_string: 'Working on session-memory tests (edited).',
  })
  assert(
    typeof allowed === 'string' && allowed.startsWith('Edited'),
    'Edit tool allows memory path',
  )
  const afterEdit = fs.readFileSync(memPath, 'utf-8')
  assert(
    afterEdit.includes('Working on session-memory tests (edited).'),
    'Edit tool wrote memory file',
  )

  // Extract queue: sequential + latest-wins coalesce
  const { enqueueSessionExtract, resetExtractQueues } =
    await import('../services/session-memory/extractQueue.js')
  resetExtractQueues()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  type TagArgs = { sessionId: string; tag: string }
  const runTagged = async (args: TagArgs) => {
    if (args.tag === 'a') {
      order.push(`start:${args.tag}`)
      await gate
      order.push(`end:${args.tag}`)
    } else {
      order.push(`run:${args.tag}`)
    }
    return { ok: true }
  }
  const slow = enqueueSessionExtract(
    { sessionId: SESSION_ID, tag: 'a' },
    false,
    runTagged,
  )
  await new Promise(r => setTimeout(r, 10))
  const mid = enqueueSessionExtract(
    { sessionId: SESSION_ID, tag: 'b' },
    false,
    runTagged,
  )
  const late = enqueueSessionExtract(
    { sessionId: SESSION_ID, tag: 'c' },
    false,
    runTagged,
  )
  release()
  const [ra, rb, rc] = await Promise.all([slow, mid, late])
  assert(ra.ok === true, 'first extract runs')
  assert(rb.error === 'coalesced', 'middle auto extract coalesced')
  assert(rc.ok === true, 'latest auto extract runs after first')
  assert(
    order.includes('run:c') && !order.includes('run:b'),
    `latest-wins ran c not b (order=${order.join(',')})`,
  )
  resetExtractQueues()

  // Runtime cursor survives process/cache restart; transient locks do not.
  state.initialized = true
  state.tokensAtLastExtraction = 4321
  state.lastTriggerMessageId = (msgs[1] as { uuid?: string }).uuid
  state.lastSummarizedMessageId = (msgs[2] as { uuid?: string }).uuid
  state.notesGeneration = 7
  state.inFlight = true
  state.extractionEpoch = 9
  persistSessionMemoryState(SESSION_ID)
  assert(
    fs.existsSync(getSessionMemoryStatePath(SESSION_ID)),
    'writes persistent session-memory state',
  )
  evictSessionMemoryState(SESSION_ID)
  const restored = getSessionMemoryState(SESSION_ID)
  assert(restored.initialized, 'restores initialized state')
  assert(
    restored.tokensAtLastExtraction === 4321,
    'restores token extraction baseline',
  )
  assert(
    restored.lastTriggerMessageId === state.lastTriggerMessageId,
    'restores extraction trigger cursor',
  )
  assert(
    restored.lastSummarizedMessageId === state.lastSummarizedMessageId,
    'restores compaction cursor',
  )
  assert(restored.notesGeneration === 7, 'restores notes generation')
  assert(
    !restored.inFlight && restored.extractionEpoch === 0,
    'does not restore stale process-local extraction lock',
  )

  // Cleanup
  try {
    fs.rmSync(path.join(path.dirname(memPath), '..'), {
      recursive: true,
      force: true,
    })
  } catch {
    // ignore
  }
  unregisterSessionLocation(SESSION_ID)
  console.log('\nAll session-memory unit checks passed.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
