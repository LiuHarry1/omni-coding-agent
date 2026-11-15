/**
 * Offline tests for memory age, manifest, findRelevant, prefetch consume.
 * Run: npx tsx src/tests/test-memory-prefetch.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessText,
  memoryHeader,
  formatMemoryManifest,
  scanMemoryFiles,
  findFastRelevantMemories,
  findRelevantMemories,
  readMemoriesForSurfacing,
  collectSurfacedMemories,
  startRelevantMemoryPrefetch,
  hasRecallIntent,
  resolveMemoryRecallDecision,
  consumeImmediateMemoryPrefetch,
  consumeMemoryPrefetchWithTimeout,
  consumeMemoryPrefetchIfReady,
  ensureAutoMemDir,
  MAX_MEMORY_BYTES,
} from '../services/auto-memory/index.js'
import type { AutoMemoryConfig, Message } from '../core/types.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import type { IProvider } from '../services/llm/types.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

const stubProvider = {
  chatModel: () => {
    throw new Error('should not call real model')
  },
  streamTextExtras: () => ({}),
  defaultModelId: () => 'stub',
  describe: () => 'stub',
} as unknown as IProvider

const baseConfig: AutoMemoryConfig = {
  enabled: true,
  extractEveryNTurns: 1,
  cacheSafe: true,
  prefetchEnabled: true,
  prefetchModelTier: 'small',
}

async function main(): Promise<void> {
  for (const query of [
    'what did I ask you to remember last time?',
    'Do you remember what we decided?',
    'Which database did we choose previously?',
    '桌面版跨会话校验码是什么？',
    '上次我们决定用哪个数据库？',
    '之前那个 issue 后来怎样了？',
    '帮我找一下之前的聊天记录',
    '只根据记忆回答，不要写文件、不要读代码。我的测试代号是什么？',
    '根据记忆，这个仓库应该用什么测试框架？',
    '只根据你的记忆回答账单后台怎么操作',
    'Answer only from memory: what is my test codename?',
  ]) {
    assert(hasRecallIntent(query), `recall intent expected: ${query}`)
  }
  for (const query of [
    'please refactor this parser',
    'Remember to run tests',
    'Remember that we use PostgreSQL',
    '记住这个配置',
    '帮我记一下这个路径',
    '根据记忆，记住这个配置',
    '记得明天发送报告',
    '部署之前先运行测试',
  ]) {
    assert(!hasRecallIntent(query), `non-recall intent expected: ${query}`)
  }
  assert(
    resolveMemoryRecallDecision('ordinary request', true) === 'strong-fast-hit',
    'strong fast hit takes precedence',
  )
  assert(
    resolveMemoryRecallDecision('what did we decide last time?', false) ===
      'recall',
    'recall decision waits for semantic lane',
  )
  assert(
    resolveMemoryRecallDecision('run tests', false) === 'no-recall-intent',
    'ordinary request remains asynchronous',
  )
  console.log('ok recall intent')

  // memoryAge
  {
    const now = Date.now()
    assert(memoryAgeDays(now) === 0, 'today age days')
    assert(memoryAge(now) === 'today', 'today label')
    assert(memoryFreshnessText(now) === '', 'no caveat today')
    const d3 = now - 3 * 86_400_000
    assert(memoryAgeDays(d3) === 3, '3 days')
    assert(memoryAge(d3) === '3 days ago', '3 days label')
    assert(memoryFreshnessText(d3).includes('3 days old'), 'stale caveat')
    const h = memoryHeader('/tmp/x.md', d3)
    assert(h.includes('Memory: /tmp/x.md:'), 'header path')
    assert(h.includes('point-in-time'), 'header includes freshness')
    console.log('ok memoryAge')
  }

  // manifest
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-manifest-'))
    ensureAutoMemDir(mem)
    const mtime = Date.UTC(2026, 7, 1, 12, 0, 0)
    const topic = path.join(mem, 'prefer-concise.md')
    fs.writeFileSync(
      topic,
      `---\nname: Prefer concise\ndescription: short answers\ntype: feedback\n---\n\nbody\n`,
      'utf-8',
    )
    fs.utimesSync(topic, new Date(mtime), new Date(mtime))
    const files = scanMemoryFiles(mem)
    assert(files.length === 1, 'one topic')
    assert(files[0]!.filename === 'prefer-concise.md', 'filename')
    assert(files[0]!.filePath === topic, 'filePath')
    const manifest = formatMemoryManifest(files)
    assert(
      manifest.includes('[feedback] prefer-concise.md'),
      `manifest type+file: ${manifest}`,
    )
    assert(manifest.includes('short answers'), 'manifest description')
    assert(manifest.includes('2026-08-01T'), 'manifest ISO time')
    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok manifest')
  }

  // findRelevant
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-find-'))
    ensureAutoMemDir(mem)
    fs.writeFileSync(
      path.join(mem, 'a.md'),
      `---\nname: A\ndescription: alpha pref\ntype: user\n---\n\nAlpha body\n`,
    )
    fs.writeFileSync(
      path.join(mem, 'b.md'),
      `---\nname: B\ndescription: beta pref\ntype: feedback\n---\n\nBeta body\n`,
    )

    const selected = await findRelevantMemories(
      'what are my prefs',
      mem,
      {
        provider: stubProvider,
        modelId: 'stub',
        selectFn: async () => ['a.md', 'missing.md', 'b.md'],
      },
      [],
      new Set(),
    )
    assert(selected.length === 2, 'filters unknown filenames')
    assert(selected[0]!.path.endsWith('a.md'), 'order a')
    assert(selected[1]!.path.endsWith('b.md'), 'order b')

    const surfaced = await readMemoriesForSurfacing(selected)
    assert(surfaced.length === 2, 'surfaced both')
    assert(surfaced[0]!.content.includes('Alpha body'), 'content a')
    assert(
      typeof surfaced[0]!.header === 'string',
      `header type ${typeof surfaced[0]!.header}`,
    )
    assert(
      surfaced[0]!.header.length > 0,
      `header empty: ${JSON.stringify(surfaced[0])}`,
    )

    const skipped = await findRelevantMemories(
      'what are my prefs again',
      mem,
      {
        provider: stubProvider,
        modelId: 'stub',
        selectFn: async (_q, memories) => {
          assert(memories.length === 1, 'only unsaved candidate')
          return memories.map(m => m.filename)
        },
      },
      [],
      new Set([selected[0]!.path]),
    )
    assert(
      skipped.length === 1 && skipped[0]!.path.endsWith('b.md'),
      'surfaced skip',
    )

    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok findRelevant')
  }

  // truncation
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-trunc-'))
    ensureAutoMemDir(mem)
    const big = path.join(mem, 'big.md')
    const body = 'x'.repeat(MAX_MEMORY_BYTES + 500)
    fs.writeFileSync(
      big,
      `---\nname: Big\ndescription: huge\ntype: project\n---\n\n${body}\n`,
    )
    const st = fs.statSync(big)
    const [surf] = await readMemoriesForSurfacing([
      { path: big, mtimeMs: st.mtimeMs },
    ])
    assert(surf, 'surfaced')
    assert(surf!.content.includes('truncated'), 'truncation note')
    assert(surf!.limit != null, 'limit set')
    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok truncation')
  }

  // collect + expand
  {
    const att = createAttachmentMessage({
      type: 'relevant_memories',
      memories: [
        {
          path: '/tmp/a.md',
          content: 'hello world',
          mtimeMs: Date.now(),
          header: 'Memory (saved today): /tmp/a.md:',
        },
      ],
    })
    const msgs: Message[] = [att]
    const collected = collectSurfacedMemories(msgs)
    assert(collected.paths.has('/tmp/a.md'), 'path tracked')
    assert(collected.totalBytes === 'hello world'.length, 'bytes tracked')

    const expanded = expandAttachmentMessagesForAPI(msgs)
    assert(expanded.length === 1, 'one user msg')
    const u = expanded[0]!
    assert('role' in u && u.role === 'user', 'role user')
    assert('isMeta' in u && u.isMeta === true, 'isMeta')
    const text = typeof u.content === 'string' ? u.content : ''
    assert(text.includes('<system-reminder>'), 'system-reminder wrap')
    assert(text.includes('hello world'), 'body present')
    console.log('ok collect+expand')
  }

  // prefetch consume
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-pref-'))
    ensureAutoMemDir(mem)
    fs.writeFileSync(
      path.join(mem, 'c.md'),
      `---\nname: C\ndescription: concise style\ntype: feedback\n---\n\nBe brief\n`,
    )
    fs.writeFileSync(
      path.join(mem, 'auth.ts.md'),
      `---\nname: Auth implementation\ndescription: authentication source file\ntype: project\n---\n\nUse auth.ts\n`,
    )
    fs.writeFileSync(
      path.join(mem, 'desktop-code.md'),
      `---\nname: 桌面版跨会话校验码\ndescription: Electron memory verification\ntype: project\n---\n\nBAIZE-42\n`,
    )
    fs.writeFileSync(
      path.join(mem, 'style-a.md'),
      `---\nname: Response format\ndescription: concise response style\ntype: feedback\n---\n\nA\n`,
    )
    fs.writeFileSync(
      path.join(mem, 'style-b.md'),
      `---\nname: Review format\ndescription: concise review style\ntype: feedback\n---\n\nB\n`,
    )

    const authFast = findFastRelevantMemories('auth.ts', mem)
    assert(authFast.strong, 'short filename is a strong fast hit')
    assert(
      authFast.matches[0]?.path.endsWith('auth.ts.md'),
      'filename fast hit selects exact memory',
    )
    const surfacedAuthFast = findFastRelevantMemories(
      'auth.ts',
      mem,
      new Set([path.join(mem, 'auth.ts.md')]),
    )
    assert(
      !surfacedAuthFast.strong && surfacedAuthFast.matches.length === 0,
      'fast lane excludes already surfaced memories',
    )
    const cjkFast = findFastRelevantMemories('桌面版跨会话校验码是什么？', mem)
    assert(cjkFast.strong, 'Chinese name phrase is a strong fast hit')
    assert(
      cjkFast.matches[0]?.path.endsWith('desktop-code.md'),
      'Chinese fast hit selects exact memory',
    )
    const ambiguousFast = findFastRelevantMemories(
      'please use concise style',
      mem,
    )
    assert(
      !ambiguousFast.strong && ambiguousFast.matches.length === 0,
      'broad metadata overlap is not a strong fast hit',
    )

    const none = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'hi' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'hi',
      },
    )
    assert(none === undefined, 'single word skipped')

    let fastSelectorCalls = 0
    const shortFast = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'auth.ts' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'auth.ts',
        selectFn: async () => {
          fastSelectorCalls += 1
          return ['c.md']
        },
      },
    )
    assert(shortFast, 'short exact query starts fast prefetch')
    const shortFastAtts = consumeImmediateMemoryPrefetch(
      shortFast,
      undefined,
      0,
    )
    assert(shortFastAtts.length === 1, 'fast hit attaches before step zero')
    assert(fastSelectorCalls === 0, 'strong fast hit skips Qwen selector')
    const shortFastAgain = consumeImmediateMemoryPrefetch(
      shortFast,
      undefined,
      1,
    )
    assert(shortFastAgain.length === 0, 'fast hit is consumed only once')
    await shortFast.promise
    assert(fastSelectorCalls === 0, 'Qwen selector remains skipped')
    shortFast.dispose()

    let releaseSelector!: () => void
    const selectorGate = new Promise<void>(resolve => {
      releaseSelector = resolve
    })
    const pending = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'please remember my concise preference' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'please remember my concise preference',
        selectFn: async () => {
          await selectorGate
          return ['c.md']
        },
      },
    )
    assert(pending, 'delayed prefetch started')
    const zeroWait = await consumeMemoryPrefetchIfReady(pending, undefined, 0)
    assert(zeroWait.length === 0, 'unsettled prefetch consumes without waiting')
    releaseSelector()
    await pending.promise
    const delayedAtts = await consumeMemoryPrefetchIfReady(
      pending,
      undefined,
      1,
    )
    assert(delayedAtts.length === 1, 'settled prefetch consumed next iteration')
    pending.dispose()

    const blocking = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'what do you remember about my style?' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'what do you remember about my style?',
        selectFn: async () => ['c.md'],
      },
    )
    assert(blocking, 'blocking prefetch started')
    const blockingResult = await consumeMemoryPrefetchWithTimeout(
      blocking,
      undefined,
      0,
      100,
    )
    assert(
      !blockingResult.timedOut && blockingResult.attachments.length === 1,
      'explicit recall consumes before first model step',
    )
    blocking.dispose()

    let releaseTimedSelector!: () => void
    const timedSelectorGate = new Promise<void>(resolve => {
      releaseTimedSelector = resolve
    })
    const timed = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'what did we decide last time?' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'what did we decide last time?',
        selectFn: async () => {
          await timedSelectorGate
          return ['c.md']
        },
      },
    )
    assert(timed, 'explicit recall starts semantic prefetch')
    const timeoutResult = await consumeMemoryPrefetchWithTimeout(
      timed,
      undefined,
      0,
      5,
    )
    assert(timeoutResult.timedOut, 'explicit recall wait is bounded')
    assert(
      timed.consumedOnIteration === -1,
      'timeout leaves semantic lane unconsumed',
    )
    releaseTimedSelector()
    await timed.promise
    const lateAtts = await consumeMemoryPrefetchIfReady(timed, undefined, 1)
    assert(
      lateAtts.length === 1,
      'late semantic result attaches next iteration',
    )
    timed.dispose()

    const handle = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'please be concise in replies' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'please be concise in replies',
        selectFn: async () => ['c.md'],
      },
    )
    assert(handle, 'prefetch started')
    await handle!.promise
    assert(handle!.settledAt !== null, 'settled')

    const atts = await consumeMemoryPrefetchIfReady(handle, undefined, 0)
    assert(atts.length === 1, 'consumed once')
    assert(atts[0]!.attachment.type === 'relevant_memories', 'type')
    const again = await consumeMemoryPrefetchIfReady(handle, undefined, 1)
    assert(again.length === 0, 'no double consume')

    handle!.dispose()
    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok prefetch consume')
  }

  console.log('\nAll memory-prefetch tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
