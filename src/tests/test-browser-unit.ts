/**
 * Unit checks for the browser stack — no Chrome, no page, ~1s to run.
 *
 * The other three browser suites all need a real browser, which makes them slow
 * and makes a failure ambiguous: was it the protocol, the tool layer, or the
 * page? These cover the parts that are pure logic, so a break points straight at
 * the cause.
 *
 *   npx tsx src/tests/test-browser-unit.ts
 */
import { EventEmitter } from 'events'
import type { Page } from 'playwright-core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { WebSocket } from 'ws'
import { createExtensionBackend } from '../browser/backends/extension.js'
import {
  isRelayCdpEvent,
  isRelayHello,
  isRelayResponse,
  isRelayTargetGone,
  isRelayUserControl,
  type RelayRequestBody,
} from '../browser/relay/protocol.js'
import {
  pairingProof,
  startRelayServer,
  type RelayServer,
} from '../browser/relay/server.js'
import { BRIDGE_EXTENSION_ORIGIN } from '../browser/relay/extension-id.js'
import { startCdpEndpoint } from '../browser/relay/cdp-endpoint.js'
import type { BrowserBackend } from '../browser/types.js'
import {
  resetSettingsCache,
  resolveSettings,
} from '../core/settings-manager.js'
import {
  BrowserOutputSchema,
  browserErrorText,
  mapBrowserOutput,
  maybePersistSnapshotArtifact,
  recoverySuffixForError,
  type BrowserToolOutput,
} from '../tools/BrowserTool/shared.js'
import { withTimeout } from '../tools/BrowserTool/BrowserTool.js'
import { PAGE_SCRIPT, PAGE_SCRIPT_VERSION } from '../browser/page-script.js'
import { BrowserError } from '../browser/types.js'
import { normalizeRef } from '../browser/playwright/locator.js'
import {
  formatClickIntercept,
  isBoxInViewport,
  visibleClickPosition,
} from '../browser/playwright/robust-click.js'
import {
  keepInteractive,
  countRefs,
  formatSnapshotFileLine,
  groupBadgeLabels,
  isBlockingMessageBox,
  prioritizeAriaSnapshot,
  snapshotPreviewLines,
} from '../browser/distill-snapshot.js'
import {
  pickPageForTab,
  urlsRoughlyEqual,
} from '../browser/playwright/page-match.js'
import {
  clearCurrentTab,
  closeBrowser,
  getCurrentTabId,
  initBrowserLifecycle,
  isBrowserLive,
  resolveTab,
  setBrowserBackendFactory,
  setCurrentTab,
  shouldUseExtensionBackend,
} from '../browser/manager.js'
import {
  isHeavyMediaFrame,
  SNAPSHOT_STALL_NEXT,
} from '../browser/heavy-media.js'
import { assertNavigateUrl } from '../browser/navigate-policy.js'
import {
  isBackgroundRequestUrl,
  settleIfUrlChanged,
  withActionWait,
} from '../browser/playwright/settle.js'
import { denyCdpMethod } from '../browser/cdp-policy.js'
import { sendCdpCommand } from '../browser/cdp-command.js'
import { getBrowserLogsSessionDir } from '../core/session-paths.js'
import {
  ACTION_TIMEOUT_MS,
  CDP_INLINE_MAX_CHARS,
  DEFAULT_SNAPSHOT_DEPTH,
  SCREENSHOT_TIMEOUT_MS,
  SNAPSHOT_INLINE_MAX_BYTES,
  ACTION_SETTLE_MS,
  NETWORK_DRAIN_MS,
  STALLED_REQUEST_MS,
} from '../browser/limits.js'
import {
  planAnnotations,
  scaleAnnotations,
} from '../browser/screenshot-annotate.js'
import { appendSnapshotUrls } from '../browser/snapshot-urls.js'
import {
  formatScrollOutcome,
  scrollRemaining,
} from '../browser/scroll-report.js'
import { sanitizeUntrustedFileName } from '../browser/fs-safe/filename.js'
import { writeExternalFileWithinOutputRoot } from '../browser/output-files.js'
import { createDownloadCaptureForPage } from '../browser/playwright/download-capture.js'
import {
  elementMatchesHint,
  namesOverlap,
  parseExpectedDescription,
  parseRefMeta,
  pickRecoveredRef,
  snapshotDiff,
} from '../browser/snapshot-index.js'
import {
  ariaRefCssSelectorMessage,
  isAriaRefCssSelector,
} from '../browser/selector-guard.js'
import {
  getLastSnapshot,
  getRefMeta,
  getUserHasControl,
  isSnapshotDegraded,
  rememberSnapshot,
  resetSessionFlags,
  setSnapshotDegraded,
  setUserHasControl,
  takeUnsettledRequests,
} from '../browser/session-flags.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`)
}

function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`,
    )
  }
}

const ok = (msg: string) => console.log(`ok ${msg}`)

// ── injected page script: console + network, nothing else ─

{
  eq(PAGE_SCRIPT_VERSION, 11, 'page script bump')
  assert(
    PAGE_SCRIPT.includes(`var VERSION = ${PAGE_SCRIPT_VERSION}`),
    'injected VERSION must match PAGE_SCRIPT_VERSION or pages keep the old script',
  )

  for (const entry of ['consoleLogs', 'networkRequests', 'sinceReport']) {
    assert(PAGE_SCRIPT.includes(entry), `page script must expose ${entry}`)
  }
  assert(PAGE_SCRIPT.includes('window.fetch'), 'fetch is patched')
  assert(PAGE_SCRIPT.includes('XMLHttpRequest'), 'xhr is patched')
  assert(
    PAGE_SCRIPT.includes('unhandledrejection'),
    'uncaught rejections reach the console buffer',
  )

  // Snapshot, ref resolution and input all live in Playwright now. Any of this
  // reappearing in the page means we are back to two engines that disagree.
  for (const gone of [
    'resolveRef',
    'setValue',
    'setChecked',
    'selectOption',
    'waitStable',
    'NAME_FROM_CONTENT',
    'isPointerLabelGroup',
    'collectOverlayClickables',
    'elementFromPoint',
  ]) {
    assert(
      !PAGE_SCRIPT.includes(gone),
      `the injected script must not grow a second engine: found ${gone}`,
    )
  }
  ok('injected script v11 is the console/network buffer and nothing more')
}

// ── protocol guards ──────────────────────────────────────

{
  assert(
    isRelayResponse({ id: 1, ok: true, result: {} }),
    'success is a response',
  )
  assert(
    isRelayResponse({ id: 1, ok: false, error: 'x' }),
    'failure is a response',
  )
  assert(!isRelayResponse({ id: 'a', ok: true }), 'id must be a number')
  assert(!isRelayResponse({ id: 1 }), 'ok is required')
  assert(!isRelayResponse(null), 'null is not a response')
  assert(!isRelayResponse('{"id":1,"ok":true}'), 'a string is not a response')

  assert(isRelayHello({ type: 'hello', token: 't', version: 1 }), 'hello')
  assert(!isRelayHello({ type: 'welcome' }), 'welcome is not hello')
  assert(!isRelayHello(undefined), 'undefined is not hello')
  assert(
    isRelayCdpEvent({
      type: 'cdpEvent',
      targetId: '1',
      method: 'Runtime.executionContextCreated',
      params: {},
    }),
    'cdpEvent is an unsolicited frame',
  )
  assert(
    !isRelayCdpEvent({ type: 'cdpEvent', method: 'x' }),
    'cdpEvent requires targetId',
  )
  assert(
    isRelayTargetGone({
      type: 'targetGone',
      targetId: '7',
      reason: 'revoked',
    }),
    'targetGone is a target-scoped lifecycle frame',
  )
  assert(
    !isRelayTargetGone({
      type: 'targetGone',
      targetId: '7',
      reason: 'unknown',
    }),
    'targetGone validates its reason',
  )
  assert(
    isRelayUserControl({ type: 'userControl', hasControl: true }),
    'userControl is an unsolicited frame',
  )
  assert(
    !isRelayUserControl({ type: 'userControl' }),
    'userControl requires hasControl',
  )
  ok('protocol guards reject malformed frames')
}

// ── relay harness ────────────────────────────────────────

/** A client that speaks the protocol but answers with canned results. */
interface FakePeer {
  socket: WebSocket
  seen: RelayRequestBody[]
  /** Set to reply with an error instead of a result. */
  failWith?: string
  /** Set to never answer, to exercise timeouts and drops. */
  silent?: boolean
  close: () => Promise<void>
}

async function connectPeer(
  relay: RelayServer,
  opts: { delayMs?: number } = {},
): Promise<FakePeer> {
  const socket = new WebSocket(relay.wsUrl, {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })
  const peer: FakePeer = {
    socket,
    seen: [],
    close: () =>
      new Promise<void>(resolve => {
        if (socket.readyState === WebSocket.CLOSED) return resolve()
        socket.once('close', () => resolve())
        socket.close()
      }),
  }

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          version: 2,
          browser: 'FakePeer/1.0',
          capabilities: ['tabs.list', 'chrome.debugger.sendCommand'],
        }),
      )
    })
    socket.once('error', reject)
    socket.on('message', function onMsg(raw) {
      const msg = JSON.parse(String(raw))
      if (msg.type !== 'welcome') return
      socket.off('message', onMsg)
      resolve()
    })
  })

  socket.on('message', async raw => {
    const msg = JSON.parse(String(raw))
    if (typeof msg.id !== 'number') return
    peer.seen.push(msg)
    if (peer.silent) return
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    socket.send(
      JSON.stringify(
        peer.failWith
          ? { id: msg.id, ok: false, error: peer.failWith }
          : { id: msg.id, ok: true, result: { echo: msg.method } },
      ),
    )
  })

  return peer
}

/** Raw connection that never completes the handshake, to test rejection. */
function expectRejected(
  relay: RelayServer,
  firstFrame: string | undefined,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(relay.wsUrl, {
      origin: BRIDGE_EXTENSION_ORIGIN,
    })
    socket.once('open', () => {
      if (firstFrame !== undefined) socket.send(firstFrame)
    })
    socket.once('close', code => resolve(code))
    socket.once('error', reject)
  })
}

/** A handshake the relay must refuse before the socket ever opens. */
function expectUpgradeRefused(
  url: string,
  options: { origin?: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('open', () => {
      socket.terminate()
      reject(new Error(`relay accepted ${url} with origin ${options.origin}`))
    })
    socket.once('error', () => resolve())
    socket.once('close', () => resolve())
  })
}

async function withRelay(
  fn: (relay: RelayServer) => Promise<void>,
): Promise<void> {
  const relay = await startRelayServer()
  try {
    await fn(relay)
  } finally {
    await relay.close()
  }
}

// ── relay: bound port and connect url ────────────────────

await withRelay(async relay => {
  assert(relay.port > 0, 'the OS must have assigned a real port')
  assert(
    relay.wsUrl.startsWith(`ws://127.0.0.1:${relay.port}/relay/`),
    'the url must name the bound port and the uuid path',
  )
  eq(relay.isConnected(), false, 'no peer yet')
  eq(relay.peerName(), undefined, 'no peer name yet')
  eq(relay.capabilities().size, 0, 'no capabilities before a handshake')

  const connect = new URL(relay.connectUrl('Some Client'))
  eq(connect.protocol, 'chrome-extension:', 'consent page is in the extension')
  eq(
    connect.searchParams.get('relayUrl'),
    relay.wsUrl,
    'the connect url carries the credential',
  )
  eq(connect.searchParams.get('client'), 'Some Client', 'client name is shown')
  eq(connect.searchParams.get('proof'), null, 'no token means no proof')
  ok('relay reports its bound port and a self-contained connect url')

  const token = 'test-token-abc'
  const withToken = new URL(relay.connectUrl('Some Client', token))
  const proof = withToken.searchParams.get('proof')
  eq(proof, pairingProof(token, relay.wsUrl), 'proof is HMAC(token, wsUrl)')
  assert(
    !withToken.href.includes(token),
    'the token itself never goes on the url',
  )
  const extensionPairing = (await import(
    pathToFileURL(path.resolve('chrome-extension/pairing.js')).href
  )) as {
    pairingProof: (t: string, u: string) => Promise<string>
    sameProof: (a: string, b: string) => boolean
    generatePairingToken: () => string
  }
  eq(
    await extensionPairing.pairingProof(token, relay.wsUrl),
    proof,
    'the extension computes the same proof as the agent',
  )
  assert(
    extensionPairing.sameProof(proof!, proof!),
    'sameProof accepts a match',
  )
  assert(
    !extensionPairing.sameProof(proof!, pairingProof('other', relay.wsUrl)),
    'sameProof rejects a different token',
  )
  assert(
    extensionPairing.generatePairingToken() !==
      extensionPairing.generatePairingToken(),
    'generated tokens are random',
  )
  ok('auto-connect proof matches between agent and extension')
})

// Two relays in one process must not collide, which is the whole reason the
// port is no longer fixed.
{
  const a = await startRelayServer()
  const b = await startRelayServer()
  try {
    assert(a.port !== b.port, 'concurrent relays must get different ports')
    assert(a.wsUrl !== b.wsUrl, 'and different credentials')
  } finally {
    await a.close()
    await b.close()
  }
  ok('two relays can run side by side')
}

// ── relay: the url is the credential ─────────────────────

await withRelay(async relay => {
  // Origin is set by the browser and unforgeable from a page, so it is what
  // keeps a random local process or a website off this socket.
  await expectUpgradeRefused(relay.wsUrl, {})
  await expectUpgradeRefused(relay.wsUrl, { origin: 'https://evil.example' })
  await expectUpgradeRefused(relay.wsUrl, {
    origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })

  const wrongPath = new URL(relay.wsUrl)
  wrongPath.pathname = '/relay/00000000-0000-0000-0000-000000000000'
  await expectUpgradeRefused(wrongPath.toString(), {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })
  await expectUpgradeRefused(`ws://127.0.0.1:${relay.port}/`, {
    origin: BRIDGE_EXTENSION_ORIGIN,
  })

  eq(relay.isConnected(), false, 'refused clients must not count as connected')
  ok('relay refuses any origin or path but its own')
})

// ── relay: handshake ─────────────────────────────────────

await withRelay(async relay => {
  eq(
    await expectRejected(relay, 'not json at all'),
    1003,
    'malformed json must be rejected',
  )

  eq(
    await expectRejected(
      relay,
      JSON.stringify({ id: 1, ok: true, result: {} }),
    ),
    1008,
    'a response before the handshake must be rejected',
  )

  eq(relay.isConnected(), false, 'rejected clients must not count as connected')
  ok('relay rejects junk and skipped handshakes')
})

// ── relay: happy path + correlation ──────────────────────

await withRelay(async relay => {
  const peer = await connectPeer(relay, { delayMs: 15 })
  eq(relay.isConnected(), true, 'peer connected')
  assert(
    /FakePeer/.test(String(relay.peerName())),
    'peer name comes from hello',
  )

  // Concurrent, deliberately answered out of order by the delay.
  const [a, b, c] = await Promise.all([
    relay.request<{ echo: string }>({ method: 'tabs.list' }),
    relay.request<{ echo: string }>({ method: 'tabs.create', url: 'x' }),
    relay.request<{ echo: string }>({
      method: 'chrome.debugger.sendCommand',
      params: [{ tabId: 1 }, 'Runtime.evaluate', {}],
    }),
  ])
  eq(a.echo, 'tabs.list', 'reply a matched its request')
  eq(b.echo, 'tabs.create', 'reply b matched its request')
  eq(c.echo, 'chrome.debugger.sendCommand', 'reply c matched its request')
  eq(peer.seen.length, 3, 'peer saw three requests')

  // Ids must be distinct, or replies could cross.
  const ids = new Set(peer.seen.map(r => (r as unknown as { id: number }).id))
  eq(ids.size, 3, 'each request gets its own id')

  // A stray reply for an unknown id must not throw.
  peer.socket.send(JSON.stringify({ id: 9999, ok: true, result: {} }))
  await new Promise(r => setTimeout(r, 50))
  eq(relay.isConnected(), true, 'a stray reply must not kill the connection')

  await peer.close()
  ok('relay correlates concurrent requests and ignores stray replies')
})

await withRelay(async relay => {
  const peer = await connectPeer(relay)
  const gone = new Promise<{ targetId: string; reason: string }>(resolve => {
    const unsubscribe = relay.onTargetGone(event => {
      unsubscribe()
      resolve(event)
    })
  })
  peer.socket.send(
    JSON.stringify({
      type: 'targetGone',
      targetId: '17',
      reason: 'revoked',
    }),
  )
  const event = await gone
  eq(event.targetId, '17', 'target lifecycle event keeps its target')
  eq(event.reason, 'revoked', 'target lifecycle event keeps its reason')
  await peer.close()
  ok('relay forwards target-scoped lifecycle events')
})

// ── relay: error propagation ─────────────────────────────

await withRelay(async relay => {
  const peer = await connectPeer(relay)
  peer.failWith = 'Tab 7 is not shared with the agent.'
  const err = await relay
    .request({
      method: 'chrome.debugger.sendCommand',
      params: [{ tabId: 7 }, 'Runtime.evaluate', {}],
    })
    .then(() => null)
    .catch((e: Error) => e)
  assert(err instanceof BrowserError, 'peer errors arrive as BrowserError')
  eq(
    err.message,
    'Tab 7 is not shared with the agent.',
    'message preserved verbatim',
  )
  await peer.close()
  ok('relay propagates peer errors without mangling them')
})

// ── relay: not connected ─────────────────────────────────

await withRelay(async relay => {
  const err = await relay
    .request({ method: 'tabs.list' })
    .then(() => 'resolved')
    .catch((e: Error) => e.message)
  const msg = String(err)
  // No port or token to quote any more; what is actionable is the tab the
  // user was asked to approve, and the way to opt out entirely.
  assert(msg.includes('approve it there'), 'error points at the consent tab')
  assert(
    msg.includes('chrome-extension/README.md'),
    'error says how to install',
  )
  assert(msg.includes('"isolated"'), 'error offers the fallback')
  const shown = String(browserErrorText(new BrowserError(msg), 'navigate'))
  assert(
    shown.includes('Recovery action: stop and ask the user'),
    'recovery is to ask the user',
  )
  assert(
    !shown.includes('browser_snapshot'),
    'no snapshot advice when nothing is connected',
  )
  ok('requesting with no peer explains both ways out')
})

// ── relay: a drop fails pending work ─────────────────────

await withRelay(async relay => {
  const peer = await connectPeer(relay)
  peer.silent = true
  // Attach the rejection handler before closing the peer. Node's strict
  // unhandled-rejection mode can otherwise terminate between close and await.
  const pending = relay
    .request({ method: 'tabs.list' })
    .then(() => 'resolved')
    .catch((e: Error) => e.message)
  await new Promise(r => setTimeout(r, 30))
  await peer.close()

  const err = await pending
  assert(
    String(err).includes('disconnected'),
    `a dropped socket must fail pending work, got: ${err}`,
  )
  eq(relay.isConnected(), false, 'relay knows the peer is gone')
  ok('a dropped extension fails in-flight requests instead of hanging')
})

// ── relay: reconnect replaces the old peer ───────────────

await withRelay(async relay => {
  const first = await connectPeer(relay)
  const firstClosed = new Promise<number>(resolve =>
    first.socket.once('close', code => resolve(code)),
  )
  const second = await connectPeer(relay)

  eq(await firstClosed, 1000, 'the stale connection is closed cleanly')
  eq(relay.isConnected(), true, 'the new peer serves requests')
  const res = await relay.request<{ echo: string }>({ method: 'tabs.list' })
  eq(res.echo, 'tabs.list', 'the new peer answered')
  eq(second.seen.length, 1, 'the new peer, not the old one, got the request')
  eq(first.seen.length, 0, 'the replaced peer got nothing')
  await second.close()
  ok('a reconnecting extension replaces the previous connection')
})

// ── cdp endpoint: reconnecting Playwright gets attachedToTarget ──

{
  const tabs = [
    {
      targetId: 'tab-1',
      url: 'https://example.com/',
      title: 'Example',
    },
  ]
  const backend: BrowserBackend = {
    kind: 'extension' as const,
    async listTabs() {
      return tabs
    },
    async createTab(url: string) {
      const t = { targetId: 'tab-new', url, title: 'New' }
      tabs.push(t)
      return t
    },
    async closeTab() {},
    async focusTab() {},
    async restoreTab() {},
    async getActiveUserTabId() {
      return tabs[0]?.targetId ?? null
    },
    async send<T>() {
      return {
        targetInfo: {
          targetId: 'chrome-1',
          type: 'page',
          title: 'Example',
          url: 'https://example.com/',
        },
      } as T
    },
    async dispose() {},
  }

  await withRelay(async relay => {
    const endpoint = await startCdpEndpoint({ backend, relay })
    try {
      async function autoAttachCount(): Promise<number> {
        const ver = await fetch(`${endpoint.httpUrl}/json/version`).then(r =>
          r.json(),
        )
        const wsUrl = ver.webSocketDebuggerUrl as string
        const ws = new WebSocket(wsUrl)
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve())
          ws.once('error', reject)
        })
        let attached = 0
        ws.on('message', raw => {
          const msg = JSON.parse(String(raw)) as { method?: string }
          if (msg.method === 'Target.attachedToTarget') attached++
        })
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Target.setAutoAttach',
            params: {
              autoAttach: true,
              waitForDebuggerOnStart: false,
              flatten: true,
            },
          }),
        )
        await new Promise(r => setTimeout(r, 150))
        ws.close()
        return attached
      }

      const first = await autoAttachCount()
      const second = await autoAttachCount()
      assert(first >= 1, 'first setAutoAttach must announce existing tabs')
      assert(
        second >= 1,
        'second setAutoAttach must re-announce already-tracked tabs',
      )
      ok('cdp endpoint re-announces tabs to a reconnecting client')
    } finally {
      await endpoint.close()
    }
  })
}

// ── relay: close does not hang on a live peer ────────────

{
  const relay = await startRelayServer()
  const peer = await connectPeer(relay)
  peer.silent = true
  // Settled before close(), or the rejection close() causes has no handler yet.
  const pending = relay
    .request({ method: 'tabs.list' })
    .then(() => 'resolved')
    .catch((e: Error) => e.message)

  const closed = await Promise.race([
    relay.close().then(() => 'closed'),
    new Promise(r => setTimeout(() => r('timeout'), 3000)),
  ])
  eq(closed, 'closed', 'close() must not wait for the peer to hang up')
  assert(
    String(await pending).includes('shut down'),
    'pending work fails on shutdown',
  )
  await peer.close()
  ok('relay shutdown never blocks on a connected extension')
}

// ── relay: waitForExtension ──────────────────────────────

await withRelay(async relay => {
  const err = await relay
    .waitForExtension(150)
    .then(() => 'connected')
    .catch((e: Error) => e.message)
  assert(String(err).includes('No browser extension is connected'), 'times out')

  const waiting = relay.waitForExtension(3000)
  const peer = await connectPeer(relay)
  await waiting // resolves once the peer handshakes, rather than polling
  eq(relay.isConnected(), true, 'connected after the wait resolved')
  const disconnected = new Promise<string>(resolve => {
    const unsubscribe = relay.onDisconnect(reason => {
      unsubscribe()
      resolve(reason)
    })
  })
  await peer.close()
  assert(
    (await disconnected).includes('extension disconnected'),
    'disconnect subscribers receive an actionable reason',
  )
  ok('waitForExtension resolves on pairing and times out with guidance')
})

// ── extension backend: wire contract ─────────────────────

/** Everything the current extension build reports it can do. */
const ALL_CAPABILITIES = [
  'tabs.list',
  'tabs.create',
  'tabs.close',
  'tabs.getActiveUserTab',
  'tabs.focus',
  'tabs.restore',
  'chrome.debugger.attach',
  'chrome.debugger.detach',
  'chrome.debugger.sendCommand',
]

function makeFakeRelay(opts: {
  calls: RelayRequestBody[]
  capabilities: string[]
  reply?: (req: RelayRequestBody) => unknown
}): RelayServer {
  return {
    port: 1234,
    wsUrl: 'ws://127.0.0.1:1234/relay/test',
    connectUrl: () => 'chrome-extension://test/connect.html',
    isConnected: () => true,
    peerName: () => 'FakeChrome',
    capabilities: () => new Set(opts.capabilities),
    waitForExtension: async () => {},
    request: async <T>(req: RelayRequestBody): Promise<T> => {
      opts.calls.push(req)
      return (opts.reply?.(req) ?? {}) as T
    },
    onCdpEvent: () => () => {},
    onDisconnect: () => () => {},
    onTargetGone: () => () => {},
    notifyLock: () => {},
    close: async () => {},
  }
}

{
  const calls: RelayRequestBody[] = []
  const fakeRelay = makeFakeRelay({
    calls,
    capabilities: ALL_CAPABILITIES,
    reply: req => {
      if (req.method === 'tabs.list') {
        return [{ targetId: '7', url: 'http://a/', title: 'A' }]
      }
      if (req.method === 'tabs.create') {
        return { targetId: '8', url: 'http://b/', title: 'B' }
      }
      return { ok: 1 }
    },
  })

  const backend = await createExtensionBackend({ relay: fakeRelay })
  eq(backend.kind, 'extension', 'backend identifies itself')

  const tabs = await backend.listTabs()
  eq(tabs.length, 1, 'one tab')
  eq(tabs[0].targetId, '7', 'targetId passes through')
  eq(tabs[0].title, 'A', 'title passes through')

  const created = await backend.createTab('http://b/')
  eq(created.targetId, '8', 'created tab returned')

  await backend.closeTab('8')
  await backend.send('7', 'Runtime.evaluate', { expression: '1' })

  // The wire shape is a contract with background.js; assert it exactly.
  eq(
    JSON.stringify(calls[1]),
    '{"method":"tabs.create","url":"http://b/"}',
    'create',
  )
  eq(
    JSON.stringify(calls[2]),
    '{"method":"tabs.close","targetId":"8"}',
    'close',
  )
  // The tab id has to sit inside the debuggee argument, because that is the
  // one place the extension's ownership check looks before it forwards.
  eq(
    JSON.stringify(calls[3]),
    '{"method":"chrome.debugger.sendCommand","params":[{"tabId":7},"Runtime.evaluate",{"expression":"1"}]}',
    'cdp goes out as a reflective chrome.debugger.sendCommand',
  )

  // Disposing must never try to close the user's browser.
  await backend.dispose()
  eq(calls.length, 4, 'dispose sends nothing')
  ok('extension backend maps every operation onto the documented wire shape')
}

// ── extension backend: an older extension build ──────────

{
  const calls: RelayRequestBody[] = []
  // An extension that predates the focus methods says so in its handshake,
  // so the backend knows up front instead of finding out by failing.
  const fakeRelay = makeFakeRelay({
    calls,
    capabilities: ['tabs.list', 'tabs.create', 'chrome.debugger.sendCommand'],
  })

  const backend = await createExtensionBackend({ relay: fakeRelay })
  eq(
    await backend.getActiveUserTabId(),
    null,
    'legacy getActiveUserTab returns null',
  )
  await backend.focusTab('7', 'tab')
  await backend.focusTab('7', 'window')
  await backend.restoreTab('3')
  eq(calls.length, 0, 'nothing is sent that the extension cannot answer')
  ok('extension backend degrades on capabilities, not on failed calls')
}

// ── screenshot dual channel ──────────────────────────────

{
  const out: BrowserToolOutput = {
    action: 'screenshot',
    message: 'Screenshot of full page',
    url: 'http://localhost:5173/',
    title: 'App',
    screenshotPath: '/tmp/s/shot.png',
    screenshotUrl: '/sessions/abc/browser/shot.png',
    screenshotBase64: 'AAAABBBBCCCC',
    screenshotMediaType: 'image/png',
  }

  const mapped = mapBrowserOutput(out, 'call-1')
  assert(
    Array.isArray(mapped.content),
    'a screenshot must produce content blocks',
  )
  const blocks = mapped.content as Array<{
    type: string
    source?: { data: string }
  }>
  eq(blocks.length, 2, 'text plus image')
  eq(blocks[0].type, 'text', 'text first')
  eq(blocks[1].type, 'image', 'image second')
  eq(
    blocks[1].source?.data,
    'AAAABBBBCCCC',
    'the model receives the image bytes',
  )

  const forUi = BrowserOutputSchema.parse(out) as Record<string, unknown>
  eq(
    forUi.screenshotBase64,
    undefined,
    'base64 must never reach the UI or the log',
  )
  eq(
    forUi.screenshotUrl,
    '/sessions/abc/browser/shot.png',
    'the UI gets a URL instead',
  )
  eq(forUi.screenshotPath, '/tmp/s/shot.png', 'path is kept for the card')
  ok('screenshots go to the model as an image and to the UI as a URL')
}

{
  // Without a screenshot the result stays a plain string, so nothing downstream
  // has to handle an image block it never asked for.
  const mapped = mapBrowserOutput(
    {
      action: 'click',
      message: 'Clicked button "Save"',
      url: 'http://x/',
      title: 'X',
      snapshot: '- button "Save" [ref=e1]',
      consoleErrors: [{ level: 'error', text: 'boom' }],
    } satisfies BrowserToolOutput,
    'call-2',
  )
  eq(typeof mapped.content, 'string', 'no image means plain text')
  const text = mapped.content as string
  assert(text.startsWith('Clicked button "Save"'), 'message leads')
  assert(text.includes('Page: http://x/ — X'), 'location included')
  assert(
    text.includes('Console errors during this action (1)'),
    'errors surfaced',
  )
  assert(text.includes('boom'), 'error text included')
  assert(text.includes('- button "Save" [ref=e1]'), 'snapshot included')
  assert(
    text.indexOf('boom') < text.indexOf('- button "Save"'),
    'console errors come before the snapshot, where they will be read',
  )
  ok('text projection puts the message, errors, then snapshot in that order')
}

{
  const listing = mapBrowserOutput(
    {
      action: 'console',
      message: '2 console messages',
      url: 'http://x/',
      title: 'X',
      consoleErrors: [
        { level: 'error', text: 'boom' },
        { level: 'log', text: 'hello' },
      ],
    } satisfies BrowserToolOutput,
    'call-3',
  ).content as string
  assert(listing.includes('Console messages (2):'), listing)
  assert(!listing.includes('Console errors during this action'), listing)
  assert(
    listing.includes('[error] boom') && listing.includes('[log] hello'),
    listing,
  )
  ok('browser_console lists every level with its label, not as errors')
}

// ── error funnel ─────────────────────────────────────────

{
  const stale = browserErrorText(new BrowserError('Ref e3 is stale.'), 'click')
  assert(stale.startsWith('Error: Ref e3 is stale.'), stale)
  assert(stale.includes('Recovery action: browser_snapshot'), stale)
  assert(!stale.includes('Current page snapshot'), 'no YAML dump')
  const unexpected = browserErrorText(new Error('socket hang up'), 'click')
  assert(
    unexpected.startsWith('Error: click failed: socket hang up'),
    unexpected,
  )
  assert(unexpected.includes('Recovery action:'), unexpected)
  const weird = browserErrorText('weird', 'scroll')
  assert(weird.startsWith('Error: scroll failed: weird'), weird)
  eq(
    recoverySuffixForError('Error: Recovery action: browser_snapshot already'),
    '',
    'do not duplicate Recovery action',
  )
  const screenshotStall = recoverySuffixForError(
    'Screenshot timed out (PDF/iframe receipt previews often stall it).',
  )
  assert(
    !screenshotStall.includes('The click hit an iframe'),
    `a screenshot stall is not an iframe click:\n${screenshotStall}`,
  )
  assert(
    recoverySuffixForError(
      'Click would hit an iframe instead of the target element.',
    ).includes('The click hit an iframe'),
    'a real iframe intercept keeps the iframe hint',
  )
  assert(
    recoverySuffixForError(
      'Chrome is not rendering this tab: its window is minimized or completely covered by other windows',
    ).includes('ask the user to restore the Chrome window'),
    'a minimized window must not be told to snapshot and retry',
  )
  const intercept = browserErrorText(
    new BrowserError(
      'Click would hit a modal/dialog instead of the target element.\nClose it first.\nRecovery action: browser_click with ref "e9"',
    ),
    'click',
  )
  eq(
    intercept.match(/Recovery action:/g)?.length,
    1,
    'pre-formatted intercept keeps a single Recovery action',
  )
  ok('error funnel keeps messages actionable without dumping the tree')
}

{
  const noFile = browserErrorText(
    new BrowserError('No <input type=file> on this page (checked frames).'),
    'file_upload',
  )
  assert(
    noFile.includes(
      'Recovery action: browser_file_upload with paths only (omit ref)',
    ),
    noFile,
  )
  assert(
    !noFile.includes('Current page snapshot'),
    'no YAML dump on upload miss',
  )
  ok('file_upload miss points at omit-ref, not a snapshot dump')
}

{
  const formatted = formatClickIntercept({
    blockingType: 'modal',
    interceptedBy: 'dialog "Alert"',
    interceptedRef: 'e44',
    error: 'Click would hit a modal/dialog instead of the target element.',
    suggestion: 'Close the modal first.',
  })
  assert(
    formatted.includes('Recovery action: browser_click with ref "e44"'),
    formatted,
  )
  assert(formatted.includes('[ref=e44]'), formatted)
  ok('click intercept diagnosis names the covering ref')
}

{
  const viewport = { width: 1280, height: 800 }
  assert(
    isBoxInViewport({ x: -5, y: 20, width: 80, height: 30 }, viewport),
    'small edge tolerance should remain interactable',
  )
  assert(
    !isBoxInViewport({ x: -9581, y: -9869, width: 41, height: 24 }, viewport),
    'far-offscreen ExtJS clones must not be interactable',
  )
  assert(
    !isBoxInViewport({ x: -10, y: 20, width: 5, height: 30 }, viewport),
    'a box entirely outside the viewport must fail despite edge tolerance',
  )
  assert(
    !isBoxInViewport({ x: 20, y: 20, width: 0, height: 30 }, viewport),
    'zero-width elements must not be interactable',
  )
  assert(
    isBoxInViewport({ x: 16, y: -571, width: 406, height: 2006 }, viewport),
    'an element taller than the viewport is interactable once it overlaps',
  )
  assert(
    isBoxInViewport({ x: -933, y: 372, width: 2400, height: 120 }, viewport),
    'an element wider than the viewport is interactable once it overlaps',
  )
  assert(
    !isBoxInViewport({ x: -300, y: -571, width: 406, height: 2006 }, viewport),
    'the axis that fits the viewport still needs full containment',
  )
  assert(
    !isBoxInViewport({ x: 16, y: 900, width: 406, height: 2006 }, viewport),
    'an oversized element entirely below the viewport must fail',
  )
  const tallClick = visibleClickPosition(
    { x: 16, y: -571, width: 406, height: 2006 },
    viewport,
    { x: 203, y: 1003 },
  )
  assert(
    -571 + tallClick.y > 0 && -571 + tallClick.y < viewport.height,
    'an oversized element clicks inside its visible part',
  )
  const clamped = visibleClickPosition(
    { x: -5, y: 20, width: 8, height: 30 },
    viewport,
    { x: 4, y: 15 },
  )
  assert(
    -5 + clamped.x > 0 && -5 + clamped.x < 3,
    'a partially offscreen target must click its visible intersection',
  )
  ok('viewport geometry rejects hidden offscreen click targets')
}

{
  eq(
    denyCdpMethod('Runtime.evaluate'),
    undefined,
    'Runtime.evaluate is the evaluate hatch',
  )
  const deniedDom = denyCdpMethod('DOM.getDocument')
  assert(
    typeof deniedDom === 'string' && /browser_snapshot/.test(deniedDom),
    'DOM.getDocument is denied — use snapshot / get_text / evaluate',
  )
  assert(
    typeof deniedDom === 'string' && !/click a node/i.test(deniedDom),
    'DOM.getDocument denial must not suggest clicking via evaluate',
  )
  const deniedFlat = denyCdpMethod('DOM.getFlattenedDocument')
  assert(
    typeof deniedFlat === 'string' && /not allowed/.test(deniedFlat),
    'DOM.getFlattenedDocument is denied',
  )
  eq(denyCdpMethod('Profiler.start'), undefined, 'Profiler is allowed')
  eq(denyCdpMethod('Network.enable'), undefined, 'Network.enable is allowed')
  eq(
    denyCdpMethod('Page.reload'),
    undefined,
    'Page.reload is not on the deny list',
  )
  assert(
    /Input\.\*/.test(String(denyCdpMethod('Input.dispatchMouseEvent'))),
    'Input.* gets a dedicated error pointing at browser tools',
  )
  eq(
    denyCdpMethod('Browser.close'),
    "CDP method 'Browser.close' is not allowed",
    'Browser domain is blocked',
  )
  eq(
    denyCdpMethod('Storage.getCookies'),
    "CDP method 'Storage.getCookies' is not allowed",
    'Storage domain is blocked',
  )
  eq(
    denyCdpMethod('Network.getCookies'),
    "CDP method 'Network.getCookies' is not allowed",
    'cookie methods are blocked',
  )
  eq(
    denyCdpMethod('Page.navigate'),
    "CDP method 'Page.navigate' is not allowed",
    'CDP navigation is blocked',
  )
  eq(
    denyCdpMethod('DOM.setFileInputFiles'),
    "CDP method 'DOM.setFileInputFiles' is not allowed",
    'file input is blocked',
  )
  ok('cdp deny list matches the expected methods')
}

{
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const backend = {
    kind: 'isolated' as const,
    async listTabs() {
      return []
    },
    async createTab() {
      return { targetId: 't', url: '', title: '' }
    },
    async closeTab() {},
    async send(_id: string, method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'number', value: 2 } } as never
      }
      if (method === 'Profiler.stop') {
        return { profile: { ok: true } } as never
      }
      if (method === 'huge') {
        return { blob: 'x'.repeat(CDP_INLINE_MAX_CHARS + 10) } as never
      }
      return {} as never
    },
    async getActiveUserTabId() {
      return null
    },
    async focusTab() {},
    async restoreTab() {},
    async dispose() {},
  }

  const evaled = await sendCdpCommand(backend, 't', 'Runtime.evaluate', {
    expression: '1+1',
    returnByValue: true,
  })
  assert(evaled.overflow === false, 'small evaluate stays inline')
  if (evaled.overflow === false) {
    eq(
      JSON.stringify(evaled.result),
      JSON.stringify({ result: { type: 'number', value: 2 } }),
      'evaluate result is passed through',
    )
  }
  eq(calls.length, 1, 'allowed method is forwarded')

  let denied = ''
  try {
    await sendCdpCommand(backend, 't', 'Input.dispatchKeyEvent', {
      type: 'char',
      text: 'a',
    })
  } catch (err) {
    denied = err instanceof Error ? err.message : String(err)
  }
  assert(/Input\.\*/.test(denied), denied)
  eq(calls.length, 1, 'denied Input.* must not reach the backend')

  const profiled = await sendCdpCommand(backend, 't', 'Profiler.stop', {})
  assert(profiled.overflow === true, 'Profiler.stop always spills to a file')
  if (profiled.overflow === true) {
    assert(fs.existsSync(profiled.filePath), 'profile file exists')
    fs.unlinkSync(profiled.filePath)
  }

  const spilled = await sendCdpCommand(backend, 't', 'huge', {})
  assert(
    spilled.overflow === true,
    'responses over the inline cap spill to a file',
  )
  if (spilled.overflow === true) {
    assert(
      spilled.reason.includes(`${CDP_INLINE_MAX_CHARS} characters`),
      spilled.reason,
    )
    assert(fs.existsSync(spilled.filePath), 'overflow file exists')
    fs.unlinkSync(spilled.filePath)
  }
  ok('cdp send forwards allowed methods and spills large results')
}

// ── settings: the browser block is actually applied ──────

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-'))
  fs.mkdirSync(path.join(tmp, '.ai-agent'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, '.ai-agent', 'settings.json'),
    JSON.stringify({
      browser: { mode: 'extension', relayPort: 9999, headless: false },
    }),
  )
  resetSettingsCache()
  const browser = resolveSettings(tmp).config.browser
  assert(browser, 'the browser block must survive settings merging')
  eq(browser.mode, 'extension', 'mode applied')
  eq(browser.relayPort, 9999, 'relayPort applied')
  eq(browser.headless, false, 'headless applied')

  // Regression: an empty project block must not wipe defaults or throw.
  fs.writeFileSync(
    path.join(tmp, '.ai-agent', 'settings.json'),
    JSON.stringify({ browser: {} }),
  )
  resetSettingsCache()
  assert(
    resolveSettings(tmp).config.browser,
    'an empty browser block is harmless',
  )

  fs.rmSync(tmp, { recursive: true, force: true })
  resetSettingsCache()
  ok('browser settings survive the merge (regression: they used to be dropped)')
}

{
  eq(
    shouldUseExtensionBackend('auto', false),
    false,
    'auto mode silently falls back to isolated without a connected relay',
  )
  eq(
    shouldUseExtensionBackend('auto', true),
    true,
    'auto mode adopts an extension that is already connected',
  )
  eq(
    shouldUseExtensionBackend('extension', false),
    true,
    'explicit extension mode starts pairing before a relay connects',
  )
  eq(
    shouldUseExtensionBackend('isolated', true),
    false,
    'isolated mode never adopts a connected extension',
  )
  ok('browser auto mode only adopts an already-connected extension')
}

{
  eq(normalizeRef('e12'), 'e12', 'bare ref')
  eq(normalizeRef('@e12'), 'e12', '@ prefix')
  eq(normalizeRef('ref=e12'), 'e12', 'ref= prefix')
  ok('playwright ref locator accepts eN / @eN / ref=eN')
}

{
  const jobs = Array.from({ length: 80 }, (_, i) =>
    [
      `              - listitem [ref=e${100 + i}]:`,
      `                - link "Job ${i} 【 Shanghai 】 50-70k" [ref=e${200 + i}] [cursor=pointer]`,
      `                - generic [ref=e${300 + i}]: Recruiter ${i}`,
    ].join('\n'),
  ).join('\n')
  const yaml = [
    '- generic [ref=e1]:',
    '  - banner [ref=e5]:',
    '    - navigation [ref=e6]:',
    '      - link "Home" [ref=e11] [cursor=pointer]',
    '  - generic [ref=e30]:',
    '    - list [ref=e65]:',
    jobs,
    '  - generic [ref=e1363]:',
    '    - emphasis [ref=e1369] [cursor=pointer]: "1"',
    '    - generic [ref=e1370]: 有新消息',
    '  - dialog [ref=e1374]:',
    '    - generic [ref=e1383]: 我的沟通',
    '    - generic [ref=e1430] [cursor=pointer]:',
    '      - generic [ref=e1432]: 蒋先生',
    '      - paragraph [ref=e1438]: 不错过TA的回复，开启微信通知',
    '    - generic [ref=e1593] [cursor=pointer]:',
    '      - generic [ref=e1594]: 毛先生顾问',
    '      - paragraph [ref=e1595]: 驻场广州汇丰',
  ].join('\n')

  const grouped = groupBadgeLabels(yaml)
  assert(
    /generic \[ref=e1363\] \[cursor=pointer\]: 有新消息/.test(grouped),
    `badge+label must promote the parent ref:\n${grouped}`,
  )
  assert(
    !/emphasis \[ref=e1369\]/.test(grouped),
    `numeric badge must not keep a clickable ref:\n${grouped}`,
  )
  assert(grouped.includes('我的沟通'), 'grouping must not drop the dialog')

  const dock = [
    '- generic [ref=e40]:',
    '  - img [ref=e41]',
    '  - generic [cursor=pointer] [ref=e42]: "1"',
    '  - generic: Chat dock',
  ].join('\n')
  const dockGrouped = groupBadgeLabels(dock)
  assert(
    /generic \[ref=e40\] \[cursor=pointer\]: Chat dock/.test(dockGrouped),
    `icon+badge+label must still group onto the parent:\n${dockGrouped}`,
  )
  assert(
    !/\[ref=e42\]/.test(dockGrouped),
    `badge child must not stay clickable:\n${dockGrouped}`,
  )
  const dockPw = [
    '- generic [ref=f1e404]:',
    '  - img [ref=f1e405] [cursor=pointer]',
    '  - text: 1 Chat dock',
  ].join('\n')
  const dockPwGrouped = groupBadgeLabels(dockPw)
  assert(
    /generic \[ref=f1e404\] \[cursor=pointer\]: Chat dock/.test(dockPwGrouped),
    `Playwright "1 Chat dock" text must promote onto the parent:\n${dockPwGrouped}`,
  )
  assert(
    !/\[ref=f1e405\]/.test(dockPwGrouped),
    `pointer icon must not stay the click target:\n${dockPwGrouped}`,
  )
  ok('playwright yaml groups numeric badges onto the labelled parent')

  const small = prioritizeAriaSnapshot(yaml, { maxChars: yaml.length + 10 })
  eq(small.truncated, false, 'under-budget snapshot is not truncated')
  eq(small.text, grouped, 'under-budget text is the grouped yaml')

  const clipped = prioritizeAriaSnapshot(yaml, { maxChars: 2_400 })
  assert(clipped.truncated, 'over-budget snapshot is marked truncated')
  assert(
    clipped.text.length <= 2_400,
    `prioritized snapshot must fit the budget, got ${clipped.text.length}`,
  )
  assert(
    clipped.text.includes('我的沟通') && clipped.text.includes('蒋先生'),
    `dialog must survive a head-only budget:\n${clipped.text}`,
  )
  assert(
    clipped.text.includes('有新消息') || clipped.text.includes('Chat dock'),
    `end-of-tree launcher must survive truncation:\n${clipped.text.slice(-400)}`,
  )
  assert(
    !clipped.text.includes('Job 70'),
    'the middle of a long job list is what the budget should drop',
  )
  ok('playwright snapshot keeps dialogs and end chrome when truncated')

  const saveErrors = [
    '- alertdialog [active] [ref=e83]:',
    '  - heading "Error" [level=2] [ref=e90]',
    '  - generic [ref=e91]: Would you like to make corrections now?',
    '  - button "Yes" [ref=e97] [cursor=pointer]',
    '  - button "No" [ref=e98] [cursor=pointer]',
  ].join('\n')
  assert(
    isBlockingMessageBox(saveErrors),
    'an alertdialog with Yes/No is a blocking message box',
  )
  const inboxSheet = [
    '- dialog [ref=e10]:',
    '  - heading "我的沟通" [ref=e11]',
    '  - button "Close" [ref=e12]',
    ...Array.from(
      { length: 50 },
      (_, i) => `  - button "Person ${i}" [ref=e${100 + i}]`,
    ),
  ].join('\n')
  assert(
    !isBlockingMessageBox(inboxSheet),
    'a large inbox dialog is not a blocking message box',
  )
  const waitOverlay = '- dialog [ref=e1]: Please wait…'
  assert(
    !isBlockingMessageBox(waitOverlay),
    'a Please wait overlay is not a blocking message box',
  )
  ok('blocking message box heuristic keeps Error/Yes-No, drops sheets')

  const errorHeadingOnly = [
    '- heading "Error" [level=2] [ref=e90]',
    '- button "OK" [ref=e91]',
  ].join('\n')
  assert(
    !isBlockingMessageBox(errorHeadingOnly),
    'an Error heading without alertdialog/dialog is not a blocking message box',
  )
  const yesNoLoose = ['- button "Yes" [ref=e1]', '- button "No" [ref=e2]'].join(
    '\n',
  )
  assert(
    !isBlockingMessageBox(yesNoLoose),
    'Yes/No buttons without a dialog role are not a blocking message box',
  )
  const yesNoDialog = [
    '- dialog [ref=e1]:',
    '  - button "Yes" [ref=e2]',
    '  - button "No" [ref=e3]',
  ].join('\n')
  assert(
    isBlockingMessageBox(yesNoDialog),
    'a small dialog that only has Yes/No is a blocking message box',
  )
  ok('blocking message box does not key off Error heading copy')

  // Regression: maxNodes was accepted and silently ignored, so browser_snapshot
  // advertised a budget knob to the model that did nothing.
  const capped = prioritizeAriaSnapshot(yaml, {
    maxChars: 200_000,
    maxNodes: 12,
  })
  assert(
    capped.truncated,
    'a node cap below the tree marks the result truncated',
  )
  assert(
    countRefs(capped.text) <= 12,
    `node cap must bound ref-bearing nodes, got ${countRefs(capped.text)}`,
  )
  assert(
    capped.text.includes('我的沟通'),
    `a tight node cap must still spend itself on the dialog:\n${capped.text}`,
  )
  const uncapped = prioritizeAriaSnapshot(yaml, { maxChars: 200_000 })
  eq(
    uncapped.truncated,
    false,
    'no node cap, no truncation at a huge char budget',
  )
  ok('snapshot node cap bounds refs and keeps the dialog')

  const interactive = keepInteractive(yaml)
  assert(
    interactive.includes('[ref=e11]') &&
      interactive.includes('[ref=e1430]') &&
      interactive.includes('[ref=e1593]'),
    `interactive keeps role-based and pointer controls:\n${interactive}`,
  )
  assert(
    interactive.includes('dialog [ref=e1374]') &&
      !interactive.includes('我的沟通') &&
      !interactive.includes('驻场广州汇丰') &&
      !interactive.includes('Recruiter 0'),
    `interactive keeps necessary ancestors but drops unrelated ref-bearing content:\n${interactive}`,
  )
  const interactiveWithDetails = keepInteractive(
    [
      '- generic [ref=e1]:',
      '  - textbox "Email" [ref=e2]',
      '    - /placeholder: you@example.com',
      '  - heading "Ignored" [ref=e3]',
    ].join('\n'),
  )
  assert(
    interactiveWithDetails.includes('/placeholder: you@example.com') &&
      !interactiveWithDetails.includes('heading "Ignored"'),
    `interactive keeps control metadata but drops content siblings:\n${interactiveWithDetails}`,
  )
  ok('interactive snapshot keeps controls, metadata and necessary ancestors')
}

{
  const jobs = Array.from({ length: 80 }, (_, i) =>
    [
      `        - listitem [ref=f2e${100 + i}]:`,
      `          - link "Job ${i}" [ref=f2e${200 + i}] [cursor=pointer]`,
    ].join('\n'),
  ).join('\n')
  const yaml = [
    '- generic [active] [ref=f2e1]:',
    '  - banner [ref=f2e5]:',
    '    - link "Home" [ref=f2e11] [cursor=pointer]',
    '  - generic [ref=f2e30]:',
    '    - list [ref=f2e65]:',
    jobs,
    '  - generic [ref=f2e1335] [cursor=pointer]: 有新消息',
    '    - emphasis: "1"',
    '  - generic [ref=f3e1]:',
    '    - paragraph [ref=f3e74]: Copyright footer that must not steal the tail',
    '    - link "京公网安备" [ref=f3e75] [cursor=pointer]',
  ].join('\n')
  const clipped = prioritizeAriaSnapshot(yaml, { maxChars: 2_400 })
  assert(clipped.truncated, 'footer-iframe page is truncated')
  assert(
    clipped.text.includes('有新消息'),
    `primary-frame dock must survive a footer iframe tail:\n${clipped.text.slice(-500)}`,
  )
  assert(
    !clipped.text.includes('京公网安备'),
    'footer iframe must not consume the end-of-tree budget',
  )
  ok('playwright snapshot keeps primary-frame dock, not footer iframe')
}

{
  const yaml = Array.from({ length: 80 }, (_, i) => `- text: line ${i}`).join(
    '\n',
  )
  const { preview, totalLines } = snapshotPreviewLines(yaml, 50)
  eq(totalLines, 80, 'preview reports full line count')
  eq(preview.split('\n').length, 50, 'preview keeps first 50 lines')
  assert(
    preview.startsWith('- text: line 0'),
    'preview is the head of the yaml',
  )
  assert(!preview.includes('line 79'), 'preview does not include the tail')
  ok('snapshot preview is the first N lines, not a middle omit')

  const spill = path.resolve('snapshot-1.txt')
  const line = formatSnapshotFileLine(spill)
  assert(line.startsWith(`Snapshot File: [${spill}](`), line)
  assert(line.includes('file:'), line)
  ok('Snapshot File is a markdown file:// link')

  assert(isAriaRefCssSelector('[ref=e12]'), 'ref attr is not CSS')
  assert(isAriaRefCssSelector('aria-ref=e12'), 'aria-ref is not CSS')
  assert(!isAriaRefCssSelector('#main'), 'real CSS is allowed')
  const refMsg = ariaRefCssSelectorMessage('[ref=e12]')
  assert(
    refMsg.includes('not a snapshot ref'),
    'ref selector error names the mistake',
  )
  assert(
    refMsg.includes('without selector'),
    'recovery is a fresh snapshot, not Read',
  )
  assert(
    !/spilled snapshot file|\bRead\b/i.test(refMsg),
    'must not send the model to Read a log',
  )
  ok('snapshot selector rejects [ref=eN]')
}

{
  eq(DEFAULT_SNAPSHOT_DEPTH, 30, 'injected default maxDepth is 30')
  eq(SCREENSHOT_TIMEOUT_MS, 20_000, 'screenshot capture has its own 20s budget')
  assert(
    SCREENSHOT_TIMEOUT_MS > ACTION_TIMEOUT_MS,
    'screenshot timeout is longer than a click',
  )
  const sid = 'cccccccc-cccc-cccc-dddd-eeeeeeeeeeee'
  const huge = 'x'.repeat(SNAPSHOT_INLINE_MAX_BYTES + 50)
  const out: BrowserToolOutput = {
    action: 'snapshot',
    message: 'ok',
    url: 'https://example.com/',
    title: 'Example',
    snapshot: huge,
  }
  await maybePersistSnapshotArtifact(out, sid, 'call_spill')
  const dir = getBrowserLogsSessionDir(sid)
  try {
    assert(out.snapshotArtifactPath, 'large YAML spills to a file')
    assert(
      out.snapshotArtifactPath!.startsWith(dir),
      `spill under browser-logs, got ${out.snapshotArtifactPath}`,
    )
    assert(
      out.snapshotArtifactPath!.endsWith('.log'),
      'snapshot extension is .log',
    )
    assert(
      !out.snapshotArtifactPath!.includes(`${path.sep}projects${path.sep}`),
      'not under projects/',
    )
    assert(fs.existsSync(out.snapshotArtifactPath!), 'spill file exists')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  ok('large snapshot spills under .ai-agent/browser-logs/<sessionId>/')
}

// ── Playwright page matching: never pages[0] ─────────────

{
  assert(
    urlsRoughlyEqual(
      'https://www.example.com/a',
      'https://www.example.com/a?utm=1',
    ),
    'ignore query',
  )
  assert(
    urlsRoughlyEqual(
      'https://www.example.com/a#x',
      'https://www.example.com/a',
    ),
    'ignore hash',
  )
  assert(
    !urlsRoughlyEqual(
      'https://www.example.com/',
      'https://www.example.com/other',
    ),
    'different paths are not the same tab',
  )

  const stale = { url: () => 'https://www.example.com/unrelated' }
  const blank = { url: () => 'about:blank' }
  const home = { url: () => 'https://www.example.com/' }

  eq(
    pickPageForTab([stale], 'https://www.example.com/'),
    undefined,
    'must not fall back to the only Playwright page when the URL does not match',
  )
  eq(
    pickPageForTab([stale, home], 'https://www.example.com/?from=nav'),
    home,
    'match origin+path ignoring tracking query',
  )
  eq(
    pickPageForTab([stale, blank], 'about:blank'),
    blank,
    'a newly created tab may still be about:blank',
  )
  eq(
    pickPageForTab([stale, blank], 'https://www.example.com/'),
    undefined,
    'blank leftover is not a match for a real URL',
  )
  ok('findPage matching ignores stale pages[0]')

  const spaA = {
    url: () => 'https://app.example.com/app/reports/AAA/items/new',
  }
  const spaB = {
    url: () => 'https://app.example.com/app/reports/BBB',
  }
  const spaHome = { url: () => 'https://app.example.com/home' }
  eq(
    pickPageForTab(
      [spaA],
      'https://app.example.com/app/reports/AAA/items/xyz/edit',
    ),
    undefined,
    'SPA path changes are not guessed from a URL prefix',
  )
  eq(
    pickPageForTab([spaHome, spaB], 'https://app.example.com/home'),
    spaHome,
    'home is an exact path match',
  )
  ok('findPage matches origin+path and does not guess SPA routes')
}

{
  const controller = new AbortController()
  let timeoutError = ''
  try {
    await withTimeout(
      new Promise<never>(() => {}),
      'browser_test_hung',
      10,
      controller.signal,
      () => controller.abort(new Error('deadline reached')),
    )
  } catch (err) {
    timeoutError = err instanceof Error ? err.message : String(err)
  }
  assert(
    controller.signal.aborted,
    'tool deadline aborts the underlying operation',
  )
  assert(
    timeoutError.includes('timed out after 0.01s'),
    'deadline reports timeout instead of user interruption',
  )
  ok('browser tool deadline propagates cancellation')
}

{
  assert(
    isHeavyMediaFrame('https://cdn.example/invoice.pdf'),
    'pdf url is heavy',
  )
  assert(
    isHeavyMediaFrame('blob:https://app.example/uuid'),
    'blob preview is heavy',
  )
  assert(isHeavyMediaFrame('', 'application/pdf'), 'pdf mime is heavy')
  assert(
    isHeavyMediaFrame(
      'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
    ),
    'chrome pdf viewer is heavy',
  )
  assert(
    !isHeavyMediaFrame('https://app.example/nui/expense'),
    'app frame is not heavy',
  )
  assert(
    isHeavyMediaFrame('https://us2.concursolutions.com/receiptimages/abc'),
    'concur receipt preview url is heavy',
  )
  assert(
    SNAPSHOT_STALL_NEXT.includes('snapshot'),
    'stall hint tells the model to capture a new snapshot',
  )
  ok('heavy media frames are detected from src/type')
}

{
  resetSessionFlags()
  assert(!isSnapshotDegraded('t1'), 'degraded starts false')
  setSnapshotDegraded('t1', true)
  assert(isSnapshotDegraded('t1'), 'degraded can be set')
  setSnapshotDegraded('t1', false)
  assert(!isSnapshotDegraded('t1'), 'degraded can be cleared')
  setUserHasControl(true)
  assert(getUserHasControl(), 'user can take control')
  setUserHasControl(true, 'chat-a')
  setUserHasControl(false, 'chat-b')
  assert(getUserHasControl('chat-a'), 'lock is per session')
  assert(!getUserHasControl('chat-b'), 'other session stays with the agent')
  rememberSnapshot(
    't1',
    '- button "Delete Alice" [ref=e12]\n- button "Apply changes" [ref=e20]',
  )
  eq(getRefMeta('t1', 'e12')?.name, 'Delete Alice', 'sticky ref meta')
  rememberSnapshot('t1', '- button "Delete Bob" [ref=e12]')
  eq(
    getRefMeta('t1', 'e12')?.name,
    'Delete Bob',
    'ref meta tracks the latest snapshot',
  )
  assert(
    getLastSnapshot('t1')?.includes('Delete Bob'),
    'last snapshot yaml updates',
  )
  resetSessionFlags()
  assert(!getUserHasControl(), 'close/reset returns control to the agent')
  assert(!getRefMeta('t1', 'e12'), 'reset clears ref memory')
  ok('session flags for snapshot health and user control')
}

{
  const meta = parseRefMeta(
    '- heading "Dashboard" [level=1] [ref=e1]\n- button "Apply changes" [ref=e2]\n- generic [ref=e3]',
  )
  eq(meta.length, 3, 'parse three refs')
  eq(meta[1].role, 'button', 'role')
  eq(meta[1].name, 'Apply changes', 'name')
  assert(namesOverlap('Delete Alice', 'delete alice'), 'names overlap')
  assert(!namesOverlap('Delete Alice', 'Delete Bob'), 'Alice is not Bob')
  assert(
    elementMatchesHint(
      { role: 'button', name: 'Apply changes' },
      'Apply changes',
    ),
    'hint matches name',
  )
  assert(
    elementMatchesHint(
      { role: 'button', name: 'Clicked 0 times' },
      'button "Clicked 0 times"',
    ),
    'snapshot-style role plus quoted name matches',
  )
  assert(
    !elementMatchesHint(
      { role: 'link', name: 'Clicked 0 times' },
      'button "Clicked 0 times"',
    ),
    'explicit snapshot-style role must also match',
  )
  assert(
    elementMatchesHint({ role: 'button', name: 'Delete Bob' }, 'Delete Alice'),
    'some(): a shared word (delete) is enough',
  )
  assert(
    !elementMatchesHint({ role: 'button', name: 'Cancel' }, 'Delete Alice'),
    'some(): no shared word fails',
  )
  assert(
    elementMatchesHint(
      {
        role: 'a',
        name: '深圳内审及苏州公务09/01/2026CNY 678.00Not SubmittedInformation',
      },
      '深圳内审及苏州公务 report link',
    ),
    'tokens match concatenated report-row name',
  )
  assert(
    !elementMatchesHint(
      { role: 'heading', name: 'Save Expense' },
      'Save Expense button',
    ),
    'hint that says button rejects a non-button',
  )
  assert(
    !elementMatchesHint(
      { role: 'table', name: 'Save' },
      'Save button to save itinerary',
    ),
    'table Save is not a button — element should be "Save" without button',
  )
  assert(
    elementMatchesHint({ role: 'table', name: 'Save' }, 'Save'),
    'table Save matches element "Save" (no button word)',
  )
  eq(
    parseExpectedDescription('button "Save Itemization"').role,
    'button',
    'parse role from hint prefix',
  )
  eq(
    parseExpectedDescription('button "Save Itemization"').name,
    'Save Itemization',
    'parse quoted name',
  )
  eq(
    parseExpectedDescription('Save Itemization').name,
    'Save Itemization',
    'bare name hint',
  )
  const recovered = pickRecoveredRef(
    parseRefMeta(
      '- button "Cancel" [ref=e1]\n- button "Save Itemization" [ref=e9]\n- heading "Save Itemization" [ref=e2]',
    ),
    { oldRef: 'e3', role: 'button', name: 'Save Itemization' },
  )
  eq(recovered, 'e9', 'recover prefers same-role exact name, not the heading')
  const notBob = pickRecoveredRef(
    parseRefMeta('- button "Delete Bob" [ref=e12]'),
    { oldRef: 'e3', role: 'button', name: 'Delete Alice' },
  )
  eq(notBob, undefined, 'do not rematch Delete Alice onto Delete Bob')
  const diff = snapshotDiff(
    '- button "Save" [ref=e1]',
    '- button "Save" [ref=e1]\n- button "Cancel" [ref=e2]',
  )
  assert(diff.includes('Added') && diff.includes('Cancel'), diff)
  ok('snapshot index parse / hint / diff')
}

{
  eq(
    assertNavigateUrl('https://example.com/a'),
    'https://example.com/a',
    'https ok',
  )
  eq(
    assertNavigateUrl('http://localhost:5173/'),
    'http://localhost:5173/',
    'localhost ok',
  )
  let blocked = ''
  try {
    assertNavigateUrl('file:///C:/secret.txt')
  } catch (err) {
    blocked = err instanceof Error ? err.message : String(err)
  }
  assert(/file:/.test(blocked), blocked)
  blocked = ''
  try {
    assertNavigateUrl('javascript:alert(1)')
  } catch (err) {
    blocked = err instanceof Error ? err.message : String(err)
  }
  assert(/javascript:/.test(blocked), blocked)
  blocked = ''
  try {
    assertNavigateUrl('https://user:pass@example.com')
  } catch (err) {
    blocked = err instanceof Error ? err.message : String(err)
  }
  assert(/credentials/.test(blocked), blocked)
  blocked = ''
  try {
    assertNavigateUrl(
      'https://us2.concursolutions.com/nui/expense/reports/WPIXXZ',
    )
  } catch (err) {
    blocked = err instanceof Error ? err.message : String(err)
  }
  assert(/report number/.test(blocked), blocked)
  eq(
    assertNavigateUrl(
      'https://us2.concursolutions.com/nui/expense/reports/845B82A02D084FE2A7D7',
    ),
    'https://us2.concursolutions.com/nui/expense/reports/845B82A02D084FE2A7D7',
    'Concur GUID url ok',
  )
  ok('navigate policy allows http(s) and localhost, blocks file/js/credentials')
}

{
  for (const url of [
    'https://consent.trustarc.com/analytics?action=0&domain=concursolutions.com',
    'https://cdn.walkme.com/applications/accounts/workstation/settings.json',
    'https://www.google-analytics.com/g/collect?v=2',
  ]) {
    assert(isBackgroundRequestUrl(url), `background: ${url}`)
  }
  for (const url of [
    'https://us2.concursolutions.com/nui/expense/nui-shell/api/logs',
    'https://us2.concursolutions.com/nui/expense/api/reports/845B82A0',
    'https://example.com/api/catalog?q=logs',
    'https://example.com/blog/analytics-guide',
    'https://ci.example.com/api/jobs/42/logs',
    'https://grafana.example.com/api/logs/query',
    'https://app.example.com/admin/analytics/report',
    'https://shop.example.com/api/analytics',
    'https://app.example.com/api/audit-logs',
    'not a url',
  ]) {
    assert(!isBackgroundRequestUrl(url), `tracked: ${url}`)
  }
  ok('action drain skips third-party hosts only, never first-party paths')
}

{
  const page = new EventEmitter()
  const request = (url: string) => ({
    url: () => url,
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
  })
  const answered = request('https://app.example.com/api/items')
  const stalled = request('https://app.example.com/api/poll?token=secret')
  const beacon = request('https://www.google-analytics.com/g/collect')
  const adFrame = {
    ...request('https://tpc.googlesyndication.com/sodar/frame.html'),
    resourceType: () => 'document',
    isNavigationRequest: () => true,
    response: () => new Promise(() => {}),
  }
  const pageUrl = 'https://app.example.com/expenses'
  Object.assign(page, { url: () => pageUrl })
  const started = performance.now()
  await withActionWait(page as unknown as Page, 'tab-drain', async () => {
    for (const req of [answered, stalled, beacon, adFrame]) {
      page.emit('request', req)
    }
    setTimeout(() => page.emit('response', { request: () => answered }), 100)
  })
  const elapsed = performance.now() - started
  assert(
    elapsed >= STALLED_REQUEST_MS - 100 &&
      elapsed < ACTION_SETTLE_MS + NETWORK_DRAIN_MS - 500,
    `stalled request stops holding the drain (took ${Math.round(elapsed)}ms)`,
  )
  const unsettled = takeUnsettledRequests('tab-drain')
  assert(
    JSON.stringify(unsettled) === '["app.example.com/api/poll"]',
    `only the stalled request is reported, without its query: ${JSON.stringify(unsettled)}`,
  )
  assert(
    takeUnsettledRequests('tab-drain').length === 0,
    'the unsettled note is read once',
  )
  assert(page.listenerCount('request') === 0, 'drain removes its listeners')
  const settleStarted = performance.now()
  await settleIfUrlChanged(page as unknown as Page, pageUrl, 'tab-drain', {
    quick: true,
  })
  const settleMs = performance.now() - settleStarted
  assert(
    settleMs < 1_500,
    `an ad iframe load is not waited on as a navigation (took ${Math.round(settleMs)}ms)`,
  )
  ok(
    'action drain counts headers as answered, drops stalled, reports them once',
  )
}

{
  const prev = process.env.AUTH_ENABLED
  process.env.AUTH_ENABLED = 'true'
  try {
    initBrowserLifecycle()
    ok('initBrowserLifecycle does not throw under AUTH without request scope')
  } finally {
    if (prev === undefined) delete process.env.AUTH_ENABLED
    else process.env.AUTH_ENABLED = prev
  }
}

{
  // planAnnotations / scaleAnnotations
  const sampleInputs = [
    {
      ref: 'e1',
      role: 'button',
      name: 'Submit',
      doc: { x: 100, y: 200, width: 50, height: 20 },
    },
    {
      ref: 'e2',
      role: 'link',
      doc: { x: 300, y: 1500, width: 80, height: 18 },
    },
  ]
  const plan = planAnnotations({
    inputs: sampleInputs,
    space: 'viewport',
    scroll: { x: 0, y: 1000 },
  })
  eq(plan.annotations.length, 2, 'two annotations')
  eq(plan.annotations[0].box.y, -800, 'viewport subtracts scroll')
  eq(plan.skipped, 0, 'none skipped without viewport size')
  const off = planAnnotations({
    inputs: [
      {
        ref: 'e1',
        role: 'button',
        doc: { x: 10, y: 50, width: 40, height: 20 },
      },
      {
        ref: 'e2',
        role: 'link',
        doc: { x: 10, y: 5000, width: 40, height: 20 },
      },
    ],
    space: 'viewport',
    scroll: { x: 0, y: 0 },
    viewport: { width: 1280, height: 720 },
  })
  eq(off.overlayItems.length, 1, 'only in-viewport overlay')
  eq(off.skipped, 1, 'off-viewport counted skipped')
  const scaled = scaleAnnotations(plan.annotations, 2, 2)
  eq(scaled[0].box.width, 100, 'scaleAnnotations doubles width')
  const withLinks = appendSnapshotUrls('- button "Go" [ref=e1]', [
    { text: 'Go', url: 'https://example.com' },
  ])
  assert(withLinks.includes('Links:'), withLinks)
  assert(withLinks.includes('https://example.com'), withLinks)
  ok('planAnnotations / appendSnapshotUrls')
}

{
  eq(
    sanitizeUntrustedFileName('../evil.txt', 'download.bin'),
    'evil.txt',
    'basename only',
  )
  eq(
    sanitizeUntrustedFileName('CON.txt', 'download.bin'),
    'CON_.txt',
    'Windows reserved CON',
  )
  eq(
    sanitizeUntrustedFileName('', 'download.bin'),
    'download.bin',
    'empty fallback',
  )
  eq(
    sanitizeUntrustedFileName('a<>:"|?*.bin', 'download.bin'),
    'a.bin',
    'strips invalid chars',
  )
  ok('copied sanitizeUntrustedFileName')
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-agent-dl-'))
  const saved = await writeExternalFileWithinOutputRoot({
    rootDir: dir,
    path: path.join(dir, 'ok.bin'),
    write: async filePath => {
      fs.writeFileSync(filePath, 'hello')
    },
  })
  eq(fs.readFileSync(saved, 'utf8'), 'hello', 'sibling write contents')
  let escaped = false
  try {
    await writeExternalFileWithinOutputRoot({
      rootDir: dir,
      path: path.join(dir, '..', 'escape.bin'),
      write: async filePath => {
        fs.writeFileSync(filePath, 'nope')
      },
    })
  } catch {
    escaped = true
  }
  assert(escaped, 'path escape rejected')
  fs.rmSync(dir, { recursive: true, force: true })
  ok('copied writeExternalFileWithinOutputRoot')
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-agent-dl-abort-'))
  const outputPath = path.join(dir, 'cancelled.csv')
  const listeners = new Map<string, (value: unknown) => void>()
  const page = {
    on(event: string, handler: (value: unknown) => void) {
      listeners.set(event, handler)
    },
    off(event: string, handler: (value: unknown) => void) {
      if (listeners.get(event) === handler) listeners.delete(event)
    },
  } as unknown as Parameters<typeof createDownloadCaptureForPage>[0]
  const controller = new AbortController()
  const capture = createDownloadCaptureForPage(
    page,
    { downloadWaiterDepth: 0, waiters: [] },
    1_000,
    {
      mode: 'explicit',
      outputPath,
      outputRoot: dir,
      signal: controller.signal,
    },
  )
  listeners.get('download')?.({
    suggestedFilename: () => 'cancelled.csv',
    saveAs: async (tempPath: string) => {
      await new Promise(resolve => setTimeout(resolve, 200))
      fs.writeFileSync(tempPath, 'should not be committed')
    },
  })
  setTimeout(() => controller.abort(), 25)
  let rejected = false
  try {
    await capture.promise
  } catch {
    rejected = true
  }
  const outputPublished = fs.existsSync(outputPath)
  fs.rmSync(dir, { recursive: true, force: true })
  assert(rejected, 'aborting while a download is being saved must reject')
  assert(
    !outputPublished,
    'aborting while a download is being saved must not publish the output file',
  )
  ok('download capture aborts during save')
}

{
  await closeBrowser()
  let n = 0
  setBrowserBackendFactory(async () => {
    const id = `tab-${++n}`
    return {
      kind: 'isolated' as const,
      async listTabs() {
        return [{ targetId: id, url: `http://x.test/${id}`, title: id }]
      },
      async createTab() {
        return { targetId: id, url: `http://x.test/${id}`, title: id }
      },
      async closeTab() {},
      async send() {
        return {} as never
      },
      async getActiveUserTabId() {
        return null
      },
      async focusTab() {},
      async restoreTab() {},
      async dispose() {},
    }
  })
  const a = await resolveTab(process.cwd(), undefined, 'sess-a')
  const b = await resolveTab(process.cwd(), undefined, 'sess-b')
  eq(a.targetId, 'tab-1', 'session a has its own backend tab')
  eq(b.targetId, 'tab-2', 'session b has its own backend tab')
  eq(getCurrentTabId('sess-a'), 'tab-1', 'current tab is per session')
  eq(getCurrentTabId('sess-b'), 'tab-2', 'other session current tab unchanged')
  setCurrentTab('tab-1', 'sess-b')
  eq(getCurrentTabId('sess-a'), 'tab-1', 'setting b does not steal a')
  eq(getCurrentTabId('sess-b'), 'tab-1', 'b can retarget independently')
  await closeBrowser('sess-a')
  assert(!isBrowserLive('sess-a'), 'closed session a')
  assert(isBrowserLive('sess-b'), 'session b still live')
  await closeBrowser()
  setBrowserBackendFactory(null)
  assert(!isBrowserLive(), 'all sessions closed')
  ok('isolated chrome is per chat session')
}

{
  await closeBrowser()
  const open = [{ targetId: 'tab-1', url: 'http://x.test/1', title: '1' }]
  setBrowserBackendFactory(async () => ({
    kind: 'isolated' as const,
    async listTabs() {
      return [...open]
    },
    async createTab() {
      return open[0]
    },
    async closeTab() {},
    async send() {
      return {} as never
    },
    async getActiveUserTabId() {
      return null
    },
    async focusTab() {},
    async restoreTab() {},
    async dispose() {},
  }))
  eq(
    (await resolveTab(process.cwd(), undefined, 'sess-c')).targetId,
    'tab-1',
    'first tab adopted',
  )
  // The user closes the agent's tab; exactly one other tab is left behind.
  open.splice(0, 1, { targetId: 'tab-2', url: 'http://x.test/2', title: '2' })
  let err = ''
  try {
    await resolveTab(process.cwd(), undefined, 'sess-c')
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  assert(
    /was closed or is no longer shared/.test(err),
    `closed current tab must fail, got: ${err}`,
  )
  assert(
    /Recovery action: browser_tabs/.test(err),
    'closed current tab names the recovery',
  )
  eq(getCurrentTabId('sess-c'), 'tab-1', 'no silent switch to the leftover tab')
  setCurrentTab('tab-2', 'sess-c')
  eq(
    (await resolveTab(process.cwd(), undefined, 'sess-c')).targetId,
    'tab-2',
    'explicit select recovers',
  )
  clearCurrentTab('sess-c')
  eq(
    (await resolveTab(process.cwd(), undefined, 'sess-c')).targetId,
    'tab-2',
    'no current tab falls back to the only one',
  )
  await closeBrowser()
  setBrowserBackendFactory(null)
  ok('a closed current tab is reported, never silently replaced')
}

// ── scroll report ────────────────────────────────────────

{
  const page = (y: number) => ({
    x: 0,
    y,
    clientWidth: 1000,
    clientHeight: 800,
    scrollWidth: 1000,
    scrollHeight: 3200,
  })
  const moved = formatScrollOutcome({
    kind: 'page',
    requested: { x: 0, y: 300 },
    moved: { x: 0, y: 300 },
    extent: page(800),
  })
  eq(
    moved,
    'Scrolled page by (0px, 300px). Position: 1.0 pages above, 2.0 pages below (viewport 800px, content 3200px)',
    'a normal scroll reports the actual delta and pages left',
  )

  const partial = formatScrollOutcome({
    kind: 'page',
    requested: { x: 0, y: 1000 },
    moved: { x: 0, y: 400 },
    extent: page(2400),
  })
  assert(
    partial.includes('by (0px, 400px); reached the bottom of the page'),
    partial,
  )
  assert(partial.endsWith('[End of page]'), partial)

  const stuck = formatScrollOutcome({
    kind: 'page',
    requested: { x: 0, y: 300 },
    moved: { x: 0, y: 0 },
    extent: page(2400),
  })
  assert(
    stuck.startsWith(
      'Warning: no scroll occurred — already at the bottom of the page',
    ),
    stuck,
  )

  const flat = formatScrollOutcome({
    kind: 'page',
    requested: { x: 0, y: -300 },
    moved: { x: 0, y: 0 },
    extent: { ...page(0), scrollHeight: 800 },
  })
  assert(flat.includes('has no scrollable overflow'), flat)
  assert(flat.includes('[Top of page] [End of page]'), flat)

  const container = formatScrollOutcome({
    kind: 'container',
    label: 'div#results',
    requested: { x: 0, y: 200 },
    moved: { x: 0, y: 200 },
    extent: {
      x: 0,
      y: 200,
      clientWidth: 400,
      clientHeight: 400,
      scrollWidth: 400,
      scrollHeight: 1000,
    },
  })
  assert(
    container.startsWith('Scrolled container div#results by (0px, 200px)'),
    container,
  )
  assert(container.includes('0.5 pages above, 1.0 pages below'), container)

  eq(
    scrollRemaining({ ...page(2399.6) }).below,
    0,
    'sub-pixel leftovers count as the bottom',
  )
  ok('scroll report: actual delta, pages above/below, edge warnings')
}

console.log('\nall browser unit tests passed')
