/**
 * Owns Chrome instances used by `browser_*` tools, plus the current tab when
 * the model does not name one.
 *
 * Isolated Chrome is one process per chat session. Extension mode shares the
 * user's Chrome (and the relay) but keeps current-tab and lock per session.
 * Launching Chrome costs ~1s, so each bucket is torn down on idle rather than
 * per tool call.
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { resolveSettings } from '../utils/settings/manager.js'
import { getUserAppDir } from '../utils/app-dir.js'
import {
  createExtensionBackend,
  getExtensionRelay,
} from './backends/extension.js'
import { createIsolatedBackend } from './backends/isolated.js'
import { isSafePathSegment } from './fs-safe/safe-path-segment.js'
import { freshIsolatedProfileDir, ISOLATED_PROFILES_DIR } from './paths.js'
import {
  attachExtensionPlaywright,
  detachPlaywright,
} from './playwright/connect.js'
import { applyFocusConfig, flushTabRestore } from './playwright/focus.js'
import { clearViewportScreenshot } from './viewport-screenshot-cache.js'
import {
  EXTENSION_TOKEN_ENV,
  openConnectPage,
  resolveExtensionToken,
} from './relay/open-connect-page.js'
import { startRelayServer, type RelayServer } from './relay/server.js'
import {
  clearTabMemory,
  DEFAULT_BROWSER_SESSION_KEY,
  onUserControlChange,
  resetSessionFlags,
} from './session-flags.js'
import { BrowserError, type BrowserBackend, type BrowserTab } from './types.js'

const IDLE_TTL_MS = 30 * 60 * 1000

export interface BrowserHandoff {
  targetId: string
  url: string
  title: string
}

interface Live {
  key: string
  backend: BrowserBackend
  currentTargetId?: string
  lastUsed: number
  lastUrl?: string
  lastTitle?: string
  ephemeralProfileDir?: string
  ownsBackend: boolean
  idleTimer: NodeJS.Timeout | null
  idleTtlMs: number
}

const lives = new Map<string, Live>()
const starting = new Map<string, Promise<Live>>()

/**
 * Ephemeral profile dirs that must not outlive the process. Tracked separately
 * from `lives` because the directory exists from the moment `start()` creates
 * it -- before the bucket is registered -- and the `exit` handler cannot await.
 */
const ephemeralProfileDirs = new Set<string>()

function removeProfileDirSync(dir: string): void {
  ephemeralProfileDirs.delete(dir)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best effort: on Windows Chrome may still hold a handle on the profile.
  }
}

/**
 * True while a Chrome still owns this profile. Chrome writes `SingletonLock` as
 * a symlink to `<hostname>-<pid>` and leaves it behind when it is killed, so
 * only the pid can tell a live profile from a stale one. Windows has no such
 * symlink, but there the directory cannot be unlinked while Chrome holds it
 * open, which gives the same protection.
 */
function isProfileHeldByLiveChrome(dir: string): boolean {
  let target: string
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the pid is taken, just owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Drop profiles orphaned by an earlier run. A hard kill (SIGKILL, crash, or the
 * Windows exit path, where the profile is still open) leaves the directory
 * behind, so without a boot-time sweep these accumulate for the life of the
 * machine. A profile another agent process is still using is skipped and gets
 * retried on a later boot.
 */
async function sweepOrphanedProfiles(): Promise<void> {
  let names: string[]
  try {
    names = await fs.promises.readdir(ISOLATED_PROFILES_DIR)
  } catch {
    return
  }
  for (const name of names) {
    const dir = path.join(ISOLATED_PROFILES_DIR, name)
    if (ephemeralProfileDirs.has(dir)) continue
    if (isProfileHeldByLiveChrome(dir)) continue
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

interface SharedExtension {
  backend: BrowserBackend
  users: Set<string>
  unsubscribeTargetGone: () => void
}

let sharedExtension: SharedExtension | null = null
let sharedExtensionStarting: Promise<BrowserBackend> | null = null

function isSharedExtensionConnected(
  shared: SharedExtension | null = sharedExtension,
): boolean {
  if (!shared) return false
  return (
    getExtensionRelay(shared.backend)?.isConnected() ??
    relay?.isConnected() ??
    false
  )
}

/** Test seam: swap in a fake backend without launching Chrome. */
let backendFactory: (() => Promise<BrowserBackend>) | null = null
let backendFactoryScope: 'session' | 'shared' = 'session'

export function browserSessionKey(sessionId?: string): string {
  return sessionId && sessionId.length > 0
    ? sessionId
    : DEFAULT_BROWSER_SESSION_KEY
}

function persistProfileDir(sessionKey: string): string {
  return path.join(
    getUserAppDir(),
    'browser',
    'profiles',
    profileSegment(sessionKey),
  )
}

function profileSegment(sessionKey: string): string {
  if (isSafePathSegment(sessionKey)) return sessionKey
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16)
}

export function isBrowserLive(sessionId?: string): boolean {
  if (sessionId) return lives.has(browserSessionKey(sessionId))
  return lives.size > 0
}

export function setBrowserBackendFactory(
  factory: (() => Promise<BrowserBackend>) | null,
  options: { scope?: 'session' | 'shared' } = {},
): void {
  backendFactory = factory
  backendFactoryScope = factory ? (options.scope ?? 'session') : 'session'
}

function scheduleIdleSweep(live: Live): void {
  if (live.idleTimer) clearTimeout(live.idleTimer)
  live.idleTimer = setTimeout(() => {
    live.idleTimer = null
    if (Date.now() - live.lastUsed < live.idleTtlMs) {
      scheduleIdleSweep(live)
      return
    }
    void closeBrowser(live.key)
  }, live.idleTtlMs)
  live.idleTimer.unref?.()
}

/**
 * The relay outlives individual browser sessions: the extension reconnects on
 * its own schedule, and tearing the server down on idle would drop a pairing
 * the user already completed.
 */
let relay: RelayServer | null = null
let relayStarting: Promise<RelayServer> | null = null

onUserControlChange(hasControl => {
  relay?.notifyLock(hasControl)
})

export async function getRelay(port?: number): Promise<RelayServer> {
  if (relay) return relay
  if (!relayStarting) {
    relayStarting = startRelayServer({ port }).finally(() => {
      relayStarting = null
    })
  }
  relay = await relayStarting
  return relay
}

async function createIsolatedConfigured(
  cwd: string,
  sessionKey: string,
): Promise<{ backend: BrowserBackend; ephemeralProfileDir?: string }> {
  const config = resolveSettings(cwd).config.browser ?? {}
  const persist = config.profile === 'persist'
  const userDataDir = persist
    ? persistProfileDir(sessionKey)
    : freshIsolatedProfileDir(profileSegment(sessionKey))
  fs.mkdirSync(userDataDir, { recursive: true })
  if (!persist) ephemeralProfileDirs.add(userDataDir)
  const backend = await createIsolatedBackend({
    userDataDir,
    headless: config.headless ?? false,
    channel: config.channel,
    viewport: {
      width: config.viewportWidth ?? 1280,
      height: config.viewportHeight ?? 800,
    },
  })
  return {
    backend,
    ephemeralProfileDir: persist ? undefined : userDataDir,
  }
}

/**
 * How long to wait for the extension when it is *already* connected but the
 * handshake has not landed yet. Waiting on a human is handled separately.
 */
const EXTENSION_HANDSHAKE_TIMEOUT_MS = 30_000

async function getSharedExtensionBackend(cwd: string): Promise<BrowserBackend> {
  if (sharedExtension) return sharedExtension.backend
  if (!sharedExtensionStarting) {
    sharedExtensionStarting = (async () => {
      const config = resolveSettings(cwd).config.browser ?? {}
      const injected =
        backendFactory && backendFactoryScope === 'shared'
          ? await backendFactory()
          : null
      if (injected && injected.kind !== 'extension') {
        throw new BrowserError(
          'A shared browser backend factory must return an extension backend.',
        )
      }
      const relayInst =
        (injected && getExtensionRelay(injected)) ??
        (await getRelay(config.relayPort))

      // Ask for access only when we actually need the browser, and only if
      // nobody has granted it yet. Once the tab is up the wait is unbounded:
      // the user is being asked a question and may not answer immediately.
      // With a token nobody is asked, so a long silence means it was refused.
      let backend = injected
      if (!backend) {
        let connectTimeoutMs = EXTENSION_HANDSHAKE_TIMEOUT_MS
        const pairingToken = resolveExtensionToken(config)
        if (!relayInst.isConnected()) {
          openConnectPage(relayInst, { pairingToken })
          if (!pairingToken) connectTimeoutMs = 0
        }

        backend = await createExtensionBackend({
          relay: relayInst,
          connectTimeoutMs,
        }).catch((err: unknown) => {
          if (!pairingToken) throw err
          throw new BrowserError(
            'The browser extension did not auto-connect. If the connect tab says the token ' +
              `does not match, copy it again from the extension popup into browser.extensionToken ` +
              `(or ${EXTENSION_TOKEN_ENV}). Otherwise check the extension is installed in the ` +
              'Chrome profile that opened.\n' +
              'Recovery action: stop and ask the user to check the extension token and connection; browser tools cannot fix this',
          )
        })
      }
      await attachExtensionPlaywright(
        backend,
        getExtensionRelay(backend) ?? relayInst,
      )
      if (!sharedExtension) {
        const unsubscribeTargetGone = relayInst.onTargetGone(event => {
          clearTabMemory(event.targetId)
          clearViewportScreenshot(backend, event.targetId)
          for (const live of lives.values()) {
            if (
              live.backend === backend &&
              live.currentTargetId === event.targetId
            ) {
              live.lastUrl = undefined
              live.lastTitle = undefined
            }
          }
        })
        sharedExtension = {
          backend,
          users: new Set(),
          unsubscribeTargetGone,
        }
      }
      return backend
    })().finally(() => {
      sharedExtensionStarting = null
    })
  }
  return sharedExtensionStarting
}

/**
 * The extension dropped its socket (reloaded, Chrome restarted). Its relay url
 * lives in session storage, so it will not come back on its own: discard the
 * dead backend and ask again, keeping every session that shared it.
 */
async function reconnectSharedExtension(
  cwd: string,
  key: string,
): Promise<BrowserBackend> {
  const stale = sharedExtension
  if (stale && !isSharedExtensionConnected(stale)) {
    sharedExtension = null
    stale.unsubscribeTargetGone()
    await detachPlaywright(stale.backend).catch(() => {})
    await stale.backend.dispose().catch(() => {})
  }
  const backend = await getSharedExtensionBackend(cwd)
  for (const user of stale?.users ?? []) {
    if (lives.has(user)) sharedExtension?.users.add(user)
  }
  sharedExtension?.users.add(key)
  return backend
}

async function start(cwd: string, key: string): Promise<Live> {
  const config = resolveSettings(cwd).config.browser ?? {}
  const ttl = (config.idleTimeoutMinutes ?? 30) * 60 * 1000
  const idleTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : IDLE_TTL_MS

  if (backendFactory) {
    if (backendFactoryScope === 'shared') {
      const backend = await getSharedExtensionBackend(cwd)
      sharedExtension?.users.add(key)
      return {
        key,
        backend,
        lastUsed: Date.now(),
        ownsBackend: false,
        idleTimer: null,
        idleTtlMs,
      }
    }
    const backend = await backendFactory()
    if (backend.kind === 'extension') {
      const relayInst =
        getExtensionRelay(backend) ?? (await getRelay(config.relayPort))
      await attachExtensionPlaywright(backend, relayInst)
    }
    return {
      key,
      backend,
      lastUsed: Date.now(),
      ownsBackend: true,
      idleTimer: null,
      idleTtlMs,
    }
  }

  // "auto" uses the user's browser only if they have already offered it —
  // a silent fallback to isolated, never a prompt. "extension" is the mode
  // that goes and asks.
  const useExtension = shouldUseExtensionBackend(
    config.mode,
    relay?.isConnected() ?? false,
  )

  if (useExtension) {
    const backend = await getSharedExtensionBackend(cwd)
    sharedExtension?.users.add(key)
    return {
      key,
      backend,
      lastUsed: Date.now(),
      ownsBackend: false,
      idleTimer: null,
      idleTtlMs,
    }
  }

  const isolated = await createIsolatedConfigured(cwd, key)
  return {
    key,
    backend: isolated.backend,
    lastUsed: Date.now(),
    ephemeralProfileDir: isolated.ephemeralProfileDir,
    ownsBackend: true,
    idleTimer: null,
    idleTtlMs,
  }
}

export function shouldUseExtensionBackend(
  mode: unknown,
  relayConnected: boolean,
): boolean {
  return mode === 'extension' || (mode === 'auto' && relayConnected)
}

export async function getBrowser(
  cwd: string,
  sessionId?: string,
): Promise<BrowserBackend> {
  const key = browserSessionKey(sessionId)
  const existing = lives.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    if (
      !existing.ownsBackend &&
      (existing.backend !== sharedExtension?.backend ||
        !isSharedExtensionConnected())
    ) {
      existing.backend = await reconnectSharedExtension(cwd, key)
    }
    return existing.backend
  }
  let pending = starting.get(key)
  if (!pending) {
    pending = start(cwd, key).finally(() => {
      starting.delete(key)
    })
    starting.set(key, pending)
  }
  const live = await pending
  lives.set(key, live)
  scheduleIdleSweep(live)
  const config = resolveSettings(cwd).config.browser ?? {}
  applyFocusConfig({
    restoreTabAfterInput: config.restoreTabAfterInput === true,
  })
  return live.backend
}

async function disposeLive(live: Live): Promise<void> {
  await flushTabRestore().catch(() => {})
  if (live.idleTimer) {
    clearTimeout(live.idleTimer)
    live.idleTimer = null
  }
  if (live.currentTargetId) clearTabMemory(live.currentTargetId)
  resetSessionFlags(live.key)

  if (live.ownsBackend) {
    await detachPlaywright(live.backend).catch(() => {})
    await live.backend.dispose().catch(() => {})
  } else if (sharedExtension) {
    sharedExtension.users.delete(live.key)
    if (sharedExtension.users.size === 0) {
      const backend = sharedExtension.backend
      sharedExtension.unsubscribeTargetGone()
      sharedExtension = null
      await detachPlaywright(backend).catch(() => {})
      await backend.dispose().catch(() => {})
    }
  }

  if (live.ephemeralProfileDir) {
    removeProfileDirSync(live.ephemeralProfileDir)
  }
}

/**
 * Close one chat's browser, or every bucket when sessionId is omitted
 * (shutdown and tests).
 */
export async function closeBrowser(sessionId?: string): Promise<void> {
  if (sessionId) {
    const key = browserSessionKey(sessionId)
    const live = lives.get(key)
    lives.delete(key)
    if (live) await disposeLive(live)
    return
  }

  const all = [...lives.values()]
  lives.clear()
  starting.clear()
  for (const live of all) {
    await disposeLive(live)
  }
  resetSessionFlags()
}

/**
 * Resolve the tab a tool should act on: an explicit id, else the last tab the
 * model touched, else the only open tab. Opening one implicitly is deliberate —
 * the first `browser_navigate` of a session shouldn't need a separate call.
 */
export async function resolveTab(
  cwd: string,
  explicitTargetId?: string,
  sessionId?: string,
): Promise<{ backend: BrowserBackend; targetId: string }> {
  const key = browserSessionKey(sessionId)
  const backend = await getBrowser(cwd, sessionId)
  const live = lives.get(key)
  const tabs = await backend.listTabs()

  if (explicitTargetId) {
    if (!tabs.some(t => t.targetId === explicitTargetId)) {
      throw new BrowserError(
        `No open tab with id "${explicitTargetId}". Use browser_tabs to list open tabs.`,
      )
    }
    setCurrentTab(explicitTargetId, sessionId)
    return { backend, targetId: explicitTargetId }
  }

  // Once a tab has been in use, never silently swap in another one: the model
  // would keep acting as if it were still on the page it last saw.
  const current = live?.currentTargetId
  if (current) {
    if (tabs.some(t => t.targetId === current)) {
      return { backend, targetId: current }
    }
    throw new BrowserError(
      `The tab this session was using (${current}) was closed or is no longer shared with the agent. Do not assume you are still on that page.\n` +
        'Recovery action: browser_tabs with action "list", then "select" the right tab, or browser_navigate to open a fresh one',
    )
  }

  if (tabs.length === 1) {
    setCurrentTab(tabs[0].targetId, sessionId)
    recordHandoff(sessionId, tabs[0])
    return { backend, targetId: tabs[0].targetId }
  }

  if (tabs.length === 0) {
    const tab = await backend.createTab()
    setCurrentTab(tab.targetId, sessionId)
    recordHandoff(sessionId, tab)
    return { backend, targetId: tab.targetId }
  }

  // A leftover about:blank next to one real page is the usual leftover of
  // "create a tab, then the user shared another". Don't deadlock every tool
  // (including browser_tabs itself) behind a selection the model cannot make.
  const real = tabs.filter(t => t.url && t.url !== 'about:blank')
  if (real.length === 1) {
    setCurrentTab(real[0].targetId, sessionId)
    recordHandoff(sessionId, real[0])
    return { backend, targetId: real[0].targetId }
  }

  throw new BrowserError(
    'No current tab. Call browser_navigate to the start URL — it opens a fresh tab. Do not select a leftover tab from a previous task.',
  )
}

export function setCurrentTab(targetId: string, sessionId?: string): void {
  const live = lives.get(browserSessionKey(sessionId))
  if (live) {
    live.currentTargetId = targetId
    live.lastUsed = Date.now()
  }
}

export function clearCurrentTab(sessionId?: string): void {
  const live = lives.get(browserSessionKey(sessionId))
  if (live) live.currentTargetId = undefined
}

export function getCurrentTabId(sessionId?: string): string | undefined {
  return lives.get(browserSessionKey(sessionId))?.currentTargetId
}

export function recordHandoff(
  sessionId: string | undefined,
  tab: { targetId?: string; url?: string; title?: string },
): void {
  const live = lives.get(browserSessionKey(sessionId))
  if (!live) return
  if (tab.targetId) live.currentTargetId = tab.targetId
  if (tab.url) live.lastUrl = tab.url
  if (tab.title !== undefined) live.lastTitle = tab.title
  live.lastUsed = Date.now()
}

export function getBrowserHandoff(sessionId?: string): BrowserHandoff | null {
  const live = lives.get(browserSessionKey(sessionId))
  if (!live?.currentTargetId || !live.lastUrl) return null
  return {
    targetId: live.currentTargetId,
    url: live.lastUrl,
    title: live.lastTitle ?? '',
  }
}

export async function openTab(
  cwd: string,
  url?: string,
  sessionId?: string,
): Promise<BrowserTab> {
  const backend = await getBrowser(cwd, sessionId)
  const tab = await backend.createTab(url)
  setCurrentTab(tab.targetId, sessionId)
  recordHandoff(sessionId, tab)
  return tab
}

/**
 * Release every browser this process owns. Awaitable, so a caller with a real
 * shutdown sequence (see `startServer`) lets Chrome close and profiles get
 * removed instead of leaving both behind.
 */
export async function shutdownBrowserLifecycle(): Promise<void> {
  await closeBrowser().catch(() => {})
  const inst = relay
  relay = null
  await inst?.close().catch(() => {})
}

let lifecycleInstalled = false

export function initBrowserLifecycle(cwd: string = process.cwd()): void {
  if (!lifecycleInstalled) {
    lifecycleInstalled = true
    // `exit` runs no microtasks, so everything after the first `await` in
    // closeBrowser() would be queued and dropped. Only the synchronous part
    // belongs here, and it lands on POSIX only -- Chrome is still running at
    // this point, so Windows refuses to unlink the open profile and the boot
    // sweep is what reclaims it. Graceful teardown is
    // shutdownBrowserLifecycle() on the signal path.
    process.on('exit', () => {
      for (const dir of [...ephemeralProfileDirs]) removeProfileDirSync(dir)
    })

    void sweepOrphanedProfiles()
  }

  // Extension mode starts the relay at boot. First tool call also lazy-starts
  // via getRelay(); the `browser` primary agent warms it per turn as well.
  warmExtensionRelay(cwd)
}

/** Start the extension relay if extension mode is configured. */
export function warmExtensionRelay(cwd: string): void {
  let config: { mode?: string; relayPort?: number; enabled?: boolean } = {}
  try {
    config = resolveSettings(cwd).config.browser ?? {}
  } catch (err) {
    console.warn(
      `[browser] skip eager relay start: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  // Listening costs nothing and is what makes "auto" able to notice an
  // extension that connects later. It deliberately does not open the connect
  // page — starting the agent should not pop a tab.
  if (config.mode !== 'extension' && config.mode !== 'auto') return
  void getRelay(config.relayPort)
    .then(r => {
      console.log(`[browser] extension relay listening on 127.0.0.1:${r.port}`)
    })
    .catch((err: Error) => {
      console.error(`[browser] ${err.message}`)
    })
}
