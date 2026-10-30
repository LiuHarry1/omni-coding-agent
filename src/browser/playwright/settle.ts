/**
 * Letting the page catch up after an action, so the snapshot that follows shows
 * the result rather than the state just before it.
 */

import type { Page, Request, Response } from 'playwright-core'
import {
  ACTION_SETTLE_MS,
  LATE_URL_CHANGE_MS,
  NAVIGATE_NETWORK_DRAIN_MS,
  NAVIGATE_SETTLE_MS,
  NAVIGATION_LOAD_WAIT_MS,
  NETWORK_DRAIN_MS,
  STALLED_REQUEST_MS,
} from '../limits.js'
import { clearTabMemory, setUnsettledRequests } from '../session-flags.js'
import { noteClick, recordPhase } from '../click-timing.js'

/**
 * Third-party analytics, consent and in-app guidance hosts (Concur: TrustArc,
 * WalkMe) never gate what the page shows next. Matched by exact host only:
 * a URL path cannot tell a first-party log beacon from a log page's data, so
 * those are judged by how they behave (see `trackRequests`).
 */
const BACKGROUND_REQUEST_HOST =
  /(^|\.)(doubleclick\.net|googlesyndication\.com|googletagmanager\.com|google-analytics\.com|facebook\.net|hotjar\.com|clarity\.ms|mixpanel\.com|segment\.(com|io)|newrelic\.com|nr-data\.net|demdex\.net|omtrdc\.net|adobedtm\.com|sentry\.io|datadoghq\.(com|eu)|trustarc\.com|walkme\.com|pendo\.io|fullstory\.com|intercom\.io|qualtrics\.com)$/i

export function isBackgroundRequestUrl(url: string): boolean {
  try {
    return BACKGROUND_REQUEST_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function isTrackedRequest(req: Request): boolean {
  const type = req.resourceType()
  if (type !== 'xhr' && type !== 'fetch') return false
  return !isBackgroundRequestUrl(req.url())
}

/** Host and path only: query strings can carry tokens. */
export function describeRequestUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`.slice(0, 120)
  } catch {
    return url.slice(0, 120)
  }
}

interface RequestTracker {
  /** Open requests still young enough to wait on. */
  waiting(): number
  /** Every request with no response yet, stalled ones included. */
  openUrls(): string[]
  sawTracked(): boolean
  /** performance.now() of the last response, 0 if none. */
  lastAnsweredAt(): number
  dispose(): void
}

/**
 * Tracks XHR/fetch started while listening. Response headers count as the
 * answer, so a streamed body (SSE over fetch, chunked logs) does not hold the
 * wait, and a request with no answer after STALLED_REQUEST_MS stops holding
 * it too. Navigation requests go to `onNavigation` instead, except ad and
 * analytics iframes, which would otherwise hold the click for a document load.
 */
function trackRequests(
  page: Page,
  onNavigation?: (req: Request) => void,
): RequestTracker {
  const open = new Map<Request, number>()
  let sawTracked = false
  let lastAnsweredAt = 0
  const onRequest = (req: Request) => {
    if (onNavigation && req.isNavigationRequest()) {
      if (!isBackgroundRequestUrl(req.url())) onNavigation(req)
      return
    }
    if (!isTrackedRequest(req)) return
    sawTracked = true
    open.set(req, performance.now())
  }
  const onAnswered = (req: Request) => {
    if (open.delete(req)) lastAnsweredAt = performance.now()
  }
  const onResponse = (res: Response) => onAnswered(res.request())
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onAnswered)
  return {
    waiting: () => {
      const now = performance.now()
      let count = 0
      for (const startedAt of open.values()) {
        if (now - startedAt < STALLED_REQUEST_MS) count++
      }
      return count
    },
    openUrls: () => [...open.keys()].map(req => req.url()),
    sawTracked: () => sawTracked,
    lastAnsweredAt: () => lastAnsweredAt,
    dispose: () => {
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfailed', onAnswered)
    },
  }
}

export async function drainTrackedRequests(
  page: Page,
  ms: number,
): Promise<void> {
  const tracker = trackRequests(page)
  try {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (tracker.waiting() === 0) {
        await new Promise<void>(r => setTimeout(r, 150))
        if (tracker.waiting() === 0) break
      }
      await new Promise<void>(r => setTimeout(r, 50))
    }
  } finally {
    tracker.dispose()
  }
}

interface ActionOutcome {
  /** Document requests in any frame, including Concur's iframe forms. */
  navigations: Request[]
  sawTrackedRequests: boolean
  /** performance.now() when the action returned or its last XHR finished. */
  quietSince: number
}

const lastActionOutcome = new WeakMap<Page, ActionOutcome>()

/**
 * Listen for XHR/fetch started by the action, wait a short settle, then drain
 * those requests. Deliberately does not wait for an ARIA dialog to look "rich"
 * — that heuristic stalls on pages that keep polling. Requests the drain gave
 * up on are recorded for the tab so the result can tell the model to verify.
 */
export async function withActionWait<T>(
  page: Page,
  targetId: string,
  action: () => Promise<T>,
): Promise<T> {
  setUnsettledRequests(targetId, [])
  const outcome: ActionOutcome = {
    navigations: [],
    sawTrackedRequests: false,
    quietSince: 0,
  }
  const tracker = trackRequests(page, req => outcome.navigations.push(req))
  try {
    const result = await action()
    const settleStart = performance.now()
    await new Promise<void>(r => setTimeout(r, ACTION_SETTLE_MS))
    recordPhase('fixedSettle', settleStart)
    noteClick('xhrPendingAfterSettle', tracker.waiting())
    const drainStart = performance.now()
    const deadline = Date.now() + NETWORK_DRAIN_MS
    while (tracker.waiting() > 0 && Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, 50))
    }
    recordPhase('networkDrain', drainStart)
    const unsettled = tracker.openUrls().map(describeRequestUrl)
    if (unsettled.length > 0)
      noteClick('xhrStillPending', unsettled.slice(0, 5))
    setUnsettledRequests(targetId, unsettled)
    outcome.quietSince =
      unsettled.length > 0
        ? performance.now()
        : Math.max(settleStart, tracker.lastAnsweredAt())
    return result
  } finally {
    tracker.dispose()
    outcome.sawTrackedRequests = tracker.sawTracked()
    lastActionOutcome.set(page, outcome)
  }
}

async function waitForNavigations(requests: Request[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const loads = requests.map(async req => {
    try {
      const response = await req.response()
      if (!response) return
      await req.frame().waitForLoadState('domcontentloaded', {
        timeout: NAVIGATION_LOAD_WAIT_MS,
      })
    } catch {
      /* failed, detached or worker request: nothing left to wait for */
    }
  })
  await Promise.race([
    Promise.all(loads),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, NAVIGATION_LOAD_WAIT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Window an unverified action (drag, coordinate click) still gets. */
const LEGACY_URL_CHANGE_MS = 1_200

/**
 * An action that starts a navigation returns before the new document paints,
 * so snapshotting immediately still shows the previous page. Document requests
 * seen during `withActionWait` mark a real navigation (main frame or iframe).
 *
 * `quick` is for ref clicks, whose probe already confirmed delivery: a SPA
 * route change has no document request and usually lands within the settle,
 * so it is only polled for when the click also started XHR whose handler may
 * push the route late. That window counts from when the page went quiet, so
 * the settle and drain already spent count toward it. Other actions keep the
 * longer window after the drain, which also covers late input events on the
 * extension backend (e.g. a delayed dragstart).
 */
export async function settleIfUrlChanged(
  page: Page,
  urlBefore: string,
  targetId?: string,
  opts: { quick?: boolean } = {},
): Promise<void> {
  const outcome = lastActionOutcome.get(page)
  lastActionOutcome.delete(page)
  const navigations = outcome?.navigations ?? []
  noteClick('navigationRequests', navigations.length)
  if (navigations.length > 0) {
    await waitForNavigations(navigations)
  } else if (page.url() === urlBefore) {
    const deadline = !opts.quick
      ? performance.now() + LEGACY_URL_CHANGE_MS
      : outcome?.sawTrackedRequests === false
        ? 0
        : (outcome?.quietSince ?? performance.now()) + LATE_URL_CHANGE_MS
    while (performance.now() < deadline && page.url() === urlBefore) {
      await new Promise<void>(r => setTimeout(r, 100))
    }
  }
  const urlChanged = page.url() !== urlBefore
  noteClick('urlChanged', urlChanged)
  if (!urlChanged && navigations.length === 0) return
  if (urlChanged && targetId) clearTabMemory(targetId)
  await new Promise<void>(r => setTimeout(r, NAVIGATE_SETTLE_MS))
  await drainTrackedRequests(page, NAVIGATE_NETWORK_DRAIN_MS)
}
