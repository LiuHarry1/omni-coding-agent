/**
 * Conformance suite against the extension backend, over a real WebSocket relay.
 *
 * The extension is simulated by a Node client that speaks the relay protocol
 * and services requests from a real Chrome — the same thing `background.js`
 * does, with `chrome.debugger.sendCommand` swapped for a CDP session. That
 * leaves only the Chrome extension APIs untested, and covers everything that
 * could realistically differ between the two backends: the wire protocol, the
 * ownership model, correlation, error propagation, and all browser tools.
 *
 * Run: npx tsx src/tests/test-browser-relay.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WebSocket } from 'ws'
import { createExtensionBackend } from '../browser/backends/extension.js'
import {
  createIsolatedBackend,
  onIsolatedCdpEvent,
} from '../browser/backends/isolated.js'
import { BRIDGE_EXTENSION_ORIGIN } from '../browser/relay/extension-id.js'
import { startRelayServer } from '../browser/relay/server.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  runBrowserToolSuite,
  startFixtureServer,
} from './browser-tool-suite.js'
import {
  closeBrowser,
  getCurrentTabId,
  setBrowserBackendFactory,
} from '../browser/manager.js'
import {
  clickTool,
  navigateTool,
  snapshotTool,
  tabsTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'

const HEADED = process.argv.includes('--headed')

interface FakeExtension {
  close: () => Promise<void>
  setDropLifecycleEvents: (enabled: boolean) => void
  setFailNavigationStateEvaluation: (enabled: boolean) => void
  setFailTabIdentityEvaluation: (enabled: boolean) => void
  /** CDP methods the simulated extension was asked to forward. */
  seenMethods: Set<string>
  deniedCount: number
}

/**
 * Mirrors chrome-extension/background.js: only tabs the agent opened (or that were
 * explicitly shared) may be listed or driven.
 */
async function startFakeExtension(
  wsUrl: string,
  chrome: BrowserBackend,
): Promise<FakeExtension> {
  const owned = new Set<number>()
  const seenMethods = new Set<string>()
  let deniedCount = 0

  // Chrome tab ids are numbers, and the reflective protocol puts them on the
  // wire inside a debuggee object, so the fake has to hand out numbers too —
  // the CDP target strings underneath are a detail the host never sees.
  const toTabId = new Map<string, number>()
  const toCdpTarget = new Map<number, string>()
  let nextTabId = 1

  function tabIdFor(cdpTarget: string): number {
    let id = toTabId.get(cdpTarget)
    if (id === undefined) {
      id = nextTabId++
      toTabId.set(cdpTarget, id)
      toCdpTarget.set(id, cdpTarget)
    }
    return id
  }

  const ws = new WebSocket(wsUrl, { origin: BRIDGE_EXTENSION_ORIGIN })

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 2,
          browser: 'FakeChrome/1.0',
          capabilities: [
            'tabs.list',
            'tabs.create',
            'tabs.close',
            'tabs.getActiveUserTab',
            'tabs.focus',
            'tabs.restore',
            'chrome.debugger.attach',
            'chrome.debugger.detach',
            'chrome.debugger.sendCommand',
          ],
        }),
      )
    })
    ws.once('error', reject)
    ws.on('message', function onMsg(raw) {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'welcome') {
        ws.off('message', onMsg)
        resolve()
      }
    })
  })

  function assertOwned(tabId: number): string {
    const cdpTarget = owned.has(tabId) ? toCdpTarget.get(tabId) : undefined
    if (!cdpTarget) {
      deniedCount++
      throw new Error(
        `Tab ${tabId} is not shared with the agent. Open it with browser_tabs, ` +
          'or share it from the extension popup.',
      )
    }
    return cdpTarget
  }

  // Mirrors chrome.debugger.onEvent: Playwright on the host waits on these
  // (lifecycle, execution contexts), so without them every navigate hangs.
  const forwarding = new Set<number>()
  let dropLifecycleEvents = false
  let failNavigationStateEvaluation = false
  let failTabIdentityEvaluation = false
  async function adoptPopup(url: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const tabs = await chrome.listTabs()
      const popup = [...tabs]
        .reverse()
        .find(tab => tab.url === url && !owned.has(tabIdFor(tab.targetId)))
      if (popup) {
        owned.add(tabIdFor(popup.targetId))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  function forwardEvents(tabId: number, cdpTarget: string): void {
    if (forwarding.has(tabId)) return
    forwarding.add(tabId)
    onIsolatedCdpEvent(chrome, cdpTarget, (method, params) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (
        dropLifecycleEvents &&
        (method === 'Page.domContentEventFired' ||
          method === 'Page.loadEventFired' ||
          method === 'Page.lifecycleEvent' ||
          method === 'Page.frameStoppedLoading')
      ) {
        return
      }
      if (method === 'Page.windowOpen') {
        void adoptPopup(String((params as { url?: unknown })?.url ?? ''))
      }
      ws.send(
        JSON.stringify({
          type: 'cdpEvent',
          targetId: String(tabId),
          method,
          params,
        }),
      )
    })
  }

  async function handle(msg: Record<string, unknown>): Promise<unknown> {
    switch (msg.method) {
      case 'tabs.list': {
        const tabs = await chrome.listTabs()
        return tabs
          .filter(t => owned.has(tabIdFor(t.targetId)))
          .map(t => ({ ...t, targetId: String(tabIdFor(t.targetId)) }))
      }
      case 'tabs.create': {
        const tab = await chrome.createTab(msg.url as string | undefined)
        const tabId = tabIdFor(tab.targetId)
        owned.add(tabId)
        return { ...tab, targetId: String(tabId) }
      }
      case 'tabs.close': {
        const tabId = Number(msg.targetId)
        const cdpTarget = assertOwned(tabId)
        owned.delete(tabId)
        await chrome.closeTab(cdpTarget)
        return true
      }
      case 'tabs.getActiveUserTab': {
        const tabs = await chrome.listTabs()
        const tab = tabs[0]
        if (!tab) return null
        return { ...tab, targetId: String(tabIdFor(tab.targetId)) }
      }
      case 'tabs.focus':
      case 'tabs.restore':
        return true
      // Mirrors the extension's reflective path: the tab id comes out of the
      // debuggee argument and is ownership-checked before anything runs.
      case 'chrome.debugger.sendCommand': {
        const [debuggee, cdpMethod, params] = msg.params as [
          { tabId: number },
          string,
          Record<string, unknown>,
        ]
        const cdpTarget = assertOwned(debuggee.tabId)
        forwardEvents(debuggee.tabId, cdpTarget)
        seenMethods.add(cdpMethod)
        if (
          failTabIdentityEvaluation &&
          cdpMethod === 'Runtime.evaluate' &&
          String(params?.expression ?? '').includes('__aiAgentTabToken')
        ) {
          throw new Error('Injected tab identity evaluation failure')
        }
        if (
          failNavigationStateEvaluation &&
          (cdpMethod === 'Runtime.evaluate' ||
            cdpMethod === 'Runtime.callFunctionOn')
        ) {
          throw new Error('Injected navigation state evaluation failure')
        }
        return (await chrome.send(cdpTarget, cdpMethod, params)) ?? {}
      }
      default:
        throw new Error(`Unknown relay method: ${String(msg.method)}`)
    }
  }

  ws.on('message', async raw => {
    const msg = JSON.parse(String(raw))
    if (typeof msg.id !== 'number') return
    try {
      ws.send(
        JSON.stringify({ id: msg.id, ok: true, result: await handle(msg) }),
      )
    } catch (err) {
      ws.send(
        JSON.stringify({
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  })

  return {
    seenMethods,
    setDropLifecycleEvents(enabled: boolean) {
      dropLifecycleEvents = enabled
    },
    setFailNavigationStateEvaluation(enabled: boolean) {
      failNavigationStateEvaluation = enabled
    },
    setFailTabIdentityEvaluation(enabled: boolean) {
      failTabIdentityEvaluation = enabled
    },
    get deniedCount() {
      return deniedCount
    },
    close: () =>
      new Promise<void>(resolve => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once('close', () => resolve())
        ws.close()
      }),
  }
}

/** The handshake must fail before a socket opens, never after. */
async function expectHandshakeRejected(
  wsUrl: string,
  opts: { origin?: string },
): Promise<void> {
  const ws = new WebSocket(wsUrl, opts)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => reject(new Error('the relay accepted the socket')))
    ws.once('error', () => resolve())
    ws.once('close', () => resolve())
  })
  ws.terminate()
}

/**
 * Origin is written by the browser and cannot be forged from a page, so it is
 * what stops any local process — or any site running JavaScript — from
 * driving the agent's browser if it ever guesses the url.
 */
async function testRejectsBadOrigin(relayUrl: string): Promise<void> {
  await expectHandshakeRejected(relayUrl, {
    origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  await expectHandshakeRejected(relayUrl, { origin: 'https://evil.example' })
  await expectHandshakeRejected(relayUrl, {})
  console.log('ok [relay] rejects a handshake from any other origin')
}

/** The path holds the per-process uuid; without it the url is not a credential. */
async function testRejectsBadPath(relayUrl: string): Promise<void> {
  const wrong = new URL(relayUrl)
  wrong.pathname = '/relay/00000000-0000-0000-0000-000000000000'
  await expectHandshakeRejected(wrong.toString(), {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })

  const root = new URL(relayUrl)
  root.pathname = '/'
  await expectHandshakeRejected(root.toString(), {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })
  console.log('ok [relay] rejects a handshake on any other path')
}

async function runTool(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const context: ToolContext = {
    eventBus: {
      emit() {},
      on() {},
      off() {},
    } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
    sessionId,
  }
  const instance = definition.create(process.cwd(), context) as AnyTool & {
    execute: (
      input: unknown,
      options: { toolCallId: string; abortSignal?: AbortSignal },
    ) => Promise<DualChannelToolResult<Record<string, unknown>> | string>
  }
  return instance.execute(args, {
    toolCallId: `relay-fault-${Date.now()}`,
    abortSignal,
  })
}

function runNavigate(
  args: Record<string, unknown>,
  sessionId: string,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  return runTool(navigateTool, args, sessionId)
}

function expectData(
  result: DualChannelToolResult<Record<string, unknown>> | string,
): Record<string, unknown> {
  assert.ok(typeof result !== 'string', String(result))
  return result.data
}

function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find(item => item.includes(`${role} "${name}"`) && item.includes('[ref='))
  assert.ok(line, `no ref for ${role} "${name}" in:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

async function main() {
  const server = await startFixtureServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-relay-'))

  const relay = await startRelayServer()
  assert.ok(relay.port > 0, 'the OS must have assigned a port')
  assert.match(relay.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/relay\/[0-9a-f-]{36}$/)
  console.log(`ok [relay] listening on 127.0.0.1:${relay.port}`)

  await testRejectsBadOrigin(relay.wsUrl)
  await testRejectsBadPath(relay.wsUrl)

  // Stands in for the user's signed-in Chrome.
  const chrome = await createIsolatedBackend({
    userDataDir: profile,
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
  })
  const extension = await startFakeExtension(relay.wsUrl, chrome)
  assert.equal(relay.isConnected(), true)
  assert.match(String(relay.peerName()), /FakeChrome/)
  assert.ok(
    relay.capabilities().has('chrome.debugger.sendCommand'),
    'the handshake must carry what the extension can do',
  )
  console.log('ok [relay] extension connected and handshook')

  try {
    await runBrowserToolSuite({
      label: 'extension',
      baseUrl: server.url,
      sessionId: 'browser-relay-test',
      backendFactory: () => createExtensionBackend({ relay }),
      crossOriginFrames: false,
      downloads: false,
    })

    const faultSessionId = 'browser-relay-lifecycle-fault-test'
    setBrowserBackendFactory(() => createExtensionBackend({ relay }))
    try {
      const initial = await runNavigate(
        { url: `${server.url}?lifecycle=initial` },
        faultSessionId,
      )
      assert.notEqual(typeof initial, 'string', String(initial))
      extension.setDropLifecycleEvents(true)
      const withoutLifecycle = await runNavigate(
        { url: `${server.url}other?lifecycle=dropped` },
        faultSessionId,
      )
      assert.notEqual(
        typeof withoutLifecycle,
        'string',
        `a completed URL navigation must survive missing lifecycle events:\n${withoutLifecycle}`,
      )
      console.log(
        'ok [relay] completed URL navigation survives missing lifecycle events',
      )

      extension.setDropLifecycleEvents(false)
      const historyStart = await runNavigate(
        { url: `${server.url}?lifecycle=history-start` },
        faultSessionId,
      )
      assert.notEqual(typeof historyStart, 'string', String(historyStart))
      const historyEnd = await runNavigate(
        { url: `${server.url}other?lifecycle=history-end` },
        faultSessionId,
      )
      assert.notEqual(typeof historyEnd, 'string', String(historyEnd))
      extension.setDropLifecycleEvents(true)
      extension.setFailNavigationStateEvaluation(true)
      const unverifiable = await runNavigate(
        { url: `${server.url}?lifecycle=unverifiable` },
        faultSessionId,
      )
      assert.equal(
        typeof unverifiable,
        'string',
        'an unverifiable timed-out navigation must fail',
      )
      assert.match(
        String(unverifiable),
        /resulting page state could not be verified/,
      )
      assert.match(
        String(unverifiable),
        /A fresh blank tab \(\d+\) replaced unusable tab \d+ as the current target/,
      )
      assert.match(
        String(unverifiable),
        /Recovery action: retry browser_navigate to the requested URL/,
      )
      assert.doesNotMatch(String(unverifiable), /overlay|PDF|browser_snapshot/i)

      extension.setDropLifecycleEvents(false)
      extension.setFailNavigationStateEvaluation(false)
      const recovered = await runNavigate(
        { url: `${server.url}?lifecycle=recovered` },
        faultSessionId,
      )
      assert.notEqual(typeof recovered, 'string', String(recovered))
      console.log(
        'ok [relay] unverifiable navigation fails cleanly and recovers on a new tab',
      )
    } finally {
      extension.setDropLifecycleEvents(false)
      extension.setFailNavigationStateEvaluation(false)
      setBrowserBackendFactory(null)
      await closeBrowser(faultSessionId)
    }

    const identitySession = 'browser-relay-identity-fault-test'
    setBrowserBackendFactory(() => createExtensionBackend({ relay }))
    try {
      const identityUrl = `${server.url}?identity=fault`
      const firstCandidate = await relay.request<{ targetId: string }>({
        method: 'tabs.create',
        url: identityUrl,
      })
      const secondCandidate = await relay.request<{ targetId: string }>({
        method: 'tabs.create',
        url: identityUrl,
      })
      assert.ok(firstCandidate.targetId && secondCandidate.targetId)
      assert.notEqual(firstCandidate.targetId, secondCandidate.targetId)
      expectData(
        await runTool(
          tabsTool,
          { action: 'select', tabId: secondCandidate.targetId },
          identitySession,
        ),
      )

      extension.setFailTabIdentityEvaluation(true)
      const ambiguous = await runTool(snapshotTool, {}, identitySession)
      assert.equal(
        typeof ambiguous,
        'string',
        'failed identity probing with two blank tabs must not choose one',
      )
      assert.match(
        String(ambiguous),
        /Could not verify which of \d+ same-URL pages belongs to tab/,
      )

      extension.setFailTabIdentityEvaluation(false)
      const recovered = expectData(
        await runTool(snapshotTool, {}, identitySession),
      )
      assert.equal(recovered.url, identityUrl)
      for (const tabId of [firstCandidate.targetId, secondCandidate.targetId]) {
        expectData(
          await runTool(tabsTool, { action: 'close', tabId }, identitySession),
        )
      }
      console.log(
        'ok [relay] failed identity probing never guesses between same-URL tabs',
      )
    } finally {
      extension.setFailTabIdentityEvaluation(false)
      setBrowserBackendFactory(null)
      await closeBrowser(identitySession)
    }

    const sessionA = 'browser-relay-concurrent-a'
    const sessionB = 'browser-relay-concurrent-b'
    setBrowserBackendFactory(() => createExtensionBackend({ relay }))
    try {
      const sameUrl = `${server.url}?multi-session=same-url`
      const [navA, navB] = await Promise.all([
        runNavigate({ url: sameUrl }, sessionA),
        runNavigate({ url: sameUrl }, sessionB),
      ])
      const dataA = expectData(navA)
      const dataB = expectData(navB)
      const targetA = getCurrentTabId(sessionA)
      const targetB = getCurrentTabId(sessionB)
      assert.ok(targetA && targetB, 'both sessions must remember a current tab')
      assert.notEqual(
        targetA,
        targetB,
        'sessions must own distinct current tabs',
      )

      const clickA = expectData(
        await runTool(
          clickTool,
          {
            ref: refFor(String(dataA.snapshot), 'button', 'Clicked 0 times'),
          },
          sessionA,
        ),
      )
      assert.match(String(clickA.snapshot), /Clicked 1 times/)
      const observedB = expectData(await runTool(snapshotTool, {}, sessionB))
      assert.match(String(observedB.snapshot), /Clicked 0 times/)
      assert.doesNotMatch(String(observedB.snapshot), /Clicked 1 times/)
      assert.match(String(dataB.snapshot), /Clicked 0 times/)
      await closeBrowser(sessionA)
      const afterSessionAClose = expectData(
        await runTool(snapshotTool, {}, sessionB),
      )
      assert.match(String(afterSessionAClose.snapshot), /Clicked 0 times/)
      console.log(
        'ok [relay] concurrent sessions isolate same-URL tabs, refs and lifecycle',
      )
    } finally {
      setBrowserBackendFactory(null)
      await Promise.all([closeBrowser(sessionA), closeBrowser(sessionB)])
    }

    // The consent model held. The suite ends by deliberately closing an
    // already-closed tab; the host must reject it before it reaches the
    // extension ownership boundary.
    const deniedDuringSuite = extension.deniedCount
    assert.equal(
      deniedDuringSuite,
      0,
      'suite should only send agent-owned tab ids to the extension',
    )
    // And the relay really did carry the whole CDP surface.
    for (const required of [
      'Runtime.evaluate',
      'Page.addScriptToEvaluateOnNewDocument',
    ]) {
      assert.ok(
        extension.seenMethods.has(required),
        `expected ${required} to be forwarded over the relay`,
      )
    }
    console.log(
      `ok [relay] forwarded ${extension.seenMethods.size} distinct CDP methods`,
    )

    // Reflective forwarding must not become a way around the ownership model.
    // The tab id travels inside the debuggee argument now, so that is exactly
    // where the check has to happen.
    for (const attempt of [
      {
        what: 'a tab the agent never opened',
        req: {
          method: 'chrome.debugger.sendCommand' as const,
          params: [{ tabId: 999_999 }, 'Runtime.evaluate', { expression: '1' }],
        },
      },
      {
        what: 'closing a tab the agent never opened',
        req: { method: 'tabs.close' as const, targetId: '999999' },
      },
    ]) {
      const denied = await relay
        .request(attempt.req)
        .then(() => 'allowed')
        .catch((err: Error) => err.message)
      assert.match(
        String(denied),
        /is not shared with the agent/,
        `the extension must refuse ${attempt.what}`,
      )
    }
    assert.equal(
      extension.deniedCount,
      deniedDuringSuite + 2,
      'both over-reach attempts must have been counted as denials',
    )
    console.log('ok [relay] reflective calls cannot reach unowned tabs')

    const disconnectSession = 'browser-relay-disconnect-inflight-test'
    setBrowserBackendFactory(() => createExtensionBackend({ relay }))
    const disconnectAbort = new AbortController()
    let disconnectedNavigation:
      DualChannelToolResult<Record<string, unknown>> | string | 'hung' = 'hung'
    try {
      expectData(
        await runNavigate(
          { url: `${server.url}?disconnect=initial` },
          disconnectSession,
        ),
      )
      const pendingNavigation = runTool(
        navigateTool,
        { url: `${server.url}slow-navigation` },
        disconnectSession,
        disconnectAbort.signal,
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      await extension.close()
      disconnectedNavigation = await Promise.race([
        pendingNavigation,
        new Promise<'hung'>(resolve =>
          setTimeout(() => resolve('hung'), 10_000),
        ),
      ])
      if (disconnectedNavigation === 'hung') {
        disconnectAbort.abort()
        await pendingNavigation
      }
    } finally {
      setBrowserBackendFactory(null)
      await closeBrowser(disconnectSession)
    }
    assert.notEqual(
      disconnectedNavigation,
      'hung',
      'an in-flight navigation must fail promptly when the extension disconnects',
    )
    assert.equal(typeof disconnectedNavigation, 'string')
    console.log(
      'ok [relay] extension disconnect interrupts in-flight navigation',
    )

    // A disconnected extension must fail loudly rather than hang.
    await new Promise(r => setTimeout(r, 100))
    assert.equal(relay.isConnected(), false)
    const orphaned = await createExtensionBackend({
      relay,
      connectTimeoutMs: 300,
    })
      .then(() => 'connected')
      .catch((err: Error) => err.message)
    // Assert on what makes the message useful, not its exact prose: it must say
    // what is wrong, and offer both ways out.
    assert.match(String(orphaned), /No browser extension is connected/)
    assert.match(String(orphaned), /extension\/README/)
    assert.match(String(orphaned), /"isolated"/)
    console.log('ok [relay] missing extension produces an actionable error')

    const replacement = await startFakeExtension(relay.wsUrl, chrome)
    const reconnectSession = 'browser-relay-reconnect-test'
    setBrowserBackendFactory(() => createExtensionBackend({ relay }))
    try {
      const reconnected = await runNavigate(
        { url: `${server.url}?reconnect=success` },
        reconnectSession,
      )
      expectData(reconnected)
      console.log('ok [relay] tools recover after the extension reconnects')
    } finally {
      setBrowserBackendFactory(null)
      await closeBrowser(reconnectSession)
      await replacement.close()
    }

    console.log('\nall extension-backend tests passed')
  } finally {
    await extension.close().catch(() => {})
    await chrome.dispose().catch(() => {})
    await relay.close()
    await server.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
