/**
 * Click prep: scroll into view, stale-ref recovery, dropdown dismiss,
 * offset retry, and intercept diagnosis when a layer still blocks the target.
 */

import type { ElementHandle, Locator, Page } from 'playwright-core'
import {
  parseExpectedDescription,
  parseRefMeta,
  pickRecoveredRef,
} from '../snapshot-index.js'
import { getLastSnapshot, getRefMeta } from '../session-flags.js'
import { BrowserError, StaleRefError } from '../types.js'
import { noteClick, recordPhase, timed } from '../click-timing.js'
import {
  assertElementHint,
  describeElement,
  type DescribedElement,
  normalizeRef,
  targetLocator,
} from './locator.js'

export const DEFAULT_MAX_SCROLL_ATTEMPTS = 5
export const VIEWPORT_EDGE_TOLERANCE_PX = 10

export interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportLike {
  width: number
  height: number
}

/**
 * Accept a small edge tolerance after scrolling, but never treat a detached
 * popup parked thousands of pixels offscreen as interactable.
 * An axis longer than the viewport can never be fully contained, so on that
 * axis any overlap counts and the click lands in the visible intersection.
 */
export function isBoxInViewport(
  box: RectLike,
  viewport: ViewportLike,
  tolerance = VIEWPORT_EDGE_TOLERANCE_PX,
): boolean {
  const values = [
    box.x,
    box.y,
    box.width,
    box.height,
    viewport.width,
    viewport.height,
  ]
  if (!values.every(Number.isFinite)) return false
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return false
  }
  const right = box.x + box.width
  const bottom = box.y + box.height
  const intersects =
    right > 0 && bottom > 0 && box.x < viewport.width && box.y < viewport.height
  const containedX =
    box.width > viewport.width + 2 * tolerance ||
    (box.x >= -tolerance && right <= viewport.width + tolerance)
  const containedY =
    box.height > viewport.height + 2 * tolerance ||
    (box.y >= -tolerance && bottom <= viewport.height + tolerance)
  return intersects && containedX && containedY
}

export function visibleClickPosition(
  box: RectLike,
  viewport: ViewportLike,
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const visibleLeft = Math.max(box.x, 0)
  const visibleTop = Math.max(box.y, 0)
  const visibleRight = Math.min(box.x + box.width, viewport.width)
  const visibleBottom = Math.min(box.y + box.height, viewport.height)
  const insetX = Math.min(1, (visibleRight - visibleLeft) / 4)
  const insetY = Math.min(1, (visibleBottom - visibleTop) / 4)
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max)
  return {
    x:
      clamp(box.x + preferred.x, visibleLeft + insetX, visibleRight - insetX) -
      box.x,
    y:
      clamp(box.y + preferred.y, visibleTop + insetY, visibleBottom - insetY) -
      box.y,
  }
}

const TARGET_EVAL_TIMEOUT_MS = 2_000

type TargetFn<Arg, R> = (el: Element, arg: Arg) => R

/**
 * Every locator call re-runs waitForSelector through the iframe chain before
 * touching the element, about 100ms per call over the extension relay. Click
 * preflight reads go through one resolved handle instead, and fall back to the
 * locator for good once that node stops having a box (re-rendered or hidden)
 * or is found detached.
 */
interface ClickTarget {
  evaluate<Arg, R>(fn: TargetFn<Arg, R>, arg: Arg): Promise<R>
  boundingBox(): Promise<RectLike | null>
  scrollIntoViewIfNeeded(): Promise<void>
  isEnabled(): Promise<boolean>
  /** The resolved handle while it still points at the rendered node. */
  liveHandle(): ElementHandle | undefined
  /**
   * Switches to the locator if the handle's node was replaced. A detached node
   * still evaluates, with an empty rect, so a failed hit test is the cue.
   */
  dropDetachedHandle(): Promise<boolean>
}

function capped<T>(work: Promise<T>, ms = TARGET_EVAL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`element call timed out after ${ms}ms`)),
        ms,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

function locatorTarget(loc: Locator): ClickTarget {
  return {
    evaluate: <Arg, R>(fn: TargetFn<Arg, R>, arg: Arg) =>
      loc.evaluate(fn as never, arg as never, {
        timeout: TARGET_EVAL_TIMEOUT_MS,
      }) as Promise<R>,
    boundingBox: () => loc.boundingBox({ timeout: TARGET_EVAL_TIMEOUT_MS }),
    scrollIntoViewIfNeeded: () =>
      loc.scrollIntoViewIfNeeded({ timeout: TARGET_EVAL_TIMEOUT_MS }),
    isEnabled: () => loc.isEnabled({ timeout: 1_000 }),
    liveHandle: () => undefined,
    dropDetachedHandle: async () => false,
  }
}

function handleTarget(loc: Locator, handle: ElementHandle): ClickTarget {
  const fallback = locatorTarget(loc)
  let useLocator = false
  return {
    evaluate: <Arg, R>(fn: TargetFn<Arg, R>, arg: Arg) =>
      useLocator
        ? fallback.evaluate(fn, arg)
        : capped(handle.evaluate(fn as never, arg as never) as Promise<R>),
    boundingBox: async () => {
      if (!useLocator) {
        const box = await capped(handle.boundingBox()).catch(() => null)
        if (box) return box
        useLocator = true
      }
      return fallback.boundingBox()
    },
    scrollIntoViewIfNeeded: () =>
      useLocator
        ? fallback.scrollIntoViewIfNeeded()
        : capped(
            handle.scrollIntoViewIfNeeded({ timeout: TARGET_EVAL_TIMEOUT_MS }),
            TARGET_EVAL_TIMEOUT_MS + 500,
          ),
    isEnabled: () =>
      useLocator ? fallback.isEnabled() : capped(handle.isEnabled(), 1_000),
    liveHandle: () => (useLocator ? undefined : handle),
    dropDetachedHandle: async () => {
      if (useLocator) return false
      const connected = await capped(
        handle.evaluate(el => el.isConnected),
      ).catch(() => false)
      if (connected) return false
      useLocator = true
      return true
    },
  }
}

async function pageViewport(page: Page): Promise<ViewportLike> {
  const configured = page.viewportSize()
  if (configured) return configured
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
}

async function elementVisibility(target: ClickTarget): Promise<{
  connected: boolean
  hasClientRect: boolean
  display: string
  visibility: string
  opacity: number
  pointerEvents: string
} | null> {
  return target
    .evaluate(el => {
      const node = el as HTMLElement
      const style = window.getComputedStyle(node)
      return {
        connected: node.isConnected,
        hasClientRect: node.getClientRects().length > 0,
        display: style.display,
        visibility: style.visibility,
        opacity: Number.parseFloat(style.opacity || '1'),
        pointerEvents: style.pointerEvents,
      }
    }, undefined)
    .catch(() => null)
}

function visibilityFailure(
  state: Awaited<ReturnType<typeof elementVisibility>>,
): string | undefined {
  if (!state?.connected) return 'Element is detached from the document.'
  if (!state.hasClientRect || state.display === 'none') {
    return 'Element is hidden and has no visible layout box.'
  }
  if (state.visibility === 'hidden' || state.visibility === 'collapse') {
    return `Element has visibility: ${state.visibility}.`
  }
  if (Number.isFinite(state.opacity) && state.opacity <= 0) {
    return 'Element is fully transparent (opacity: 0).'
  }
  if (state.pointerEvents === 'none') {
    return 'Element has pointer-events: none.'
  }
  return undefined
}

export function recoverRefByHint(
  targetId: string,
  ref: string,
  elementHint?: string,
  knownRole?: string,
): string | undefined {
  const yaml = getLastSnapshot(targetId)
  if (!yaml) return undefined
  const parsed = parseExpectedDescription(elementHint)
  const known = getRefMeta(targetId, ref)
  return pickRecoveredRef(parseRefMeta(yaml), {
    oldRef: ref,
    role: parsed.role ?? knownRole ?? known?.role ?? null,
    name: parsed.name ?? known?.name ?? null,
  })
}

/**
 * Same rule as the snapshot's parked-element pass: the target or an ancestor
 * is an absolute/fixed box far past the document's scrollable origin, the way
 * ExtJS parks a picker or panel at -10000. Scrolling never reaches it. A row
 * scrolled out of a list is not parked: neither it nor its scroller is moved
 * off the document. RTL documents scroll into negative x, so their origin is
 * the far left of the scrollable width.
 */
const PARKED_OFFSCREEN_PX = 500

async function isParkedOffscreen(target: ClickTarget): Promise<boolean> {
  return target
    .evaluate((el, far) => {
      const doc = el.ownerDocument
      const win = doc.defaultView ?? window
      const root = doc.scrollingElement ?? doc.documentElement
      const rtl = win.getComputedStyle(doc.documentElement).direction === 'rtl'
      const minX = rtl ? root.clientWidth - root.scrollWidth : 0
      for (let node: Element | null = el; node; node = node.parentElement) {
        const position = win.getComputedStyle(node).position
        if (position !== 'absolute' && position !== 'fixed') continue
        const rect = node.getBoundingClientRect()
        if (
          rect.right + win.scrollX <= minX - far ||
          rect.bottom + win.scrollY <= -far
        ) {
          return true
        }
      }
      return false
    }, PARKED_OFFSCREEN_PX)
    .catch(() => false)
}

/**
 * Reads the box before scrolling, so a target already on screen costs no
 * scroll at all. Playwright's scrollIntoViewIfNeeded first waits for the
 * element to stay put across animation frames, which an occluded Chrome
 * window barely produces; it stays only as the fallback for nested scrollers
 * that a native centered scrollIntoView leaves clipped.
 */
export async function ensureInView(
  loc: Locator,
  page: Page,
  maxAttempts = DEFAULT_MAX_SCROLL_ATTEMPTS,
): Promise<{ box: RectLike; viewport: ViewportLike }> {
  return ensureTargetInView(locatorTarget(loc), page, maxAttempts)
}

async function ensureTargetInView(
  target: ClickTarget,
  page: Page,
  maxAttempts: number,
): Promise<{ box: RectLike; viewport: ViewportLike }> {
  let lastBox: RectLike | null = null
  let lastViewport: ViewportLike | null = null
  let parked = false
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const box = await target.boundingBox()
      const viewport = await pageViewport(page)
      lastBox = box
      lastViewport = viewport
      if (box && isBoxInViewport(box, viewport)) {
        const failure = visibilityFailure(await elementVisibility(target))
        if (failure) throw new BrowserError(failure)
        return { box, viewport }
      }
      if (box && i === 0 && (await isParkedOffscreen(target))) {
        parked = true
        break
      }
      if (i % 2 === 0) {
        await target.evaluate(
          el =>
            (el as HTMLElement).scrollIntoView({
              block: 'center',
              inline: 'center',
              behavior: 'instant',
            }),
          undefined,
        )
      } else {
        await target.scrollIntoViewIfNeeded()
      }
    } catch {
      /* scroll and retry */
    }
    await page.waitForTimeout(100)
  }

  if (parked && lastBox) {
    throw new BrowserError(
      `Element is parked offscreen (box x=${Math.round(lastBox.x)}, y=${Math.round(lastBox.y)}), ` +
        `the way ExtJS hides inactive pickers and panels; it cannot be scrolled into view. ` +
        `Capture a new snapshot and use the visible control; do not force-click this ref.`,
    )
  }

  const state = await elementVisibility(target)
  const failure = visibilityFailure(state)
  if (failure) {
    if (!state?.connected) throw new StaleRefError(failure)
    throw new BrowserError(failure)
  }
  if (!lastBox) {
    throw new StaleRefError(
      'Element has no bounding box. Capture a new snapshot and retry.',
    )
  }
  const viewport = lastViewport ?? (await pageViewport(page))
  throw new BrowserError(
    `Element remains outside the visible viewport after ${maxAttempts} scroll attempts ` +
      `(box x=${Math.round(lastBox.x)}, y=${Math.round(lastBox.y)}, ` +
      `width=${Math.round(lastBox.width)}, height=${Math.round(lastBox.height)}; ` +
      `viewport ${viewport.width}x${viewport.height}). Capture a new snapshot; ` +
      `do not force-click this ref.`,
  )
}

export interface DropdownDismissal {
  detected: boolean
  closed: boolean
  method?: 'click-body' | 'escape-on-field'
  dropdown?: string
}

/**
 * Act only when the layer covering the target is a dropdown, and never with a
 * trusted key press or a real mouse click.
 * Legacy apps (Concur/ExtJS) bind a document-level Escape to "cancel edit",
 * and a real click at a fixed corner can hit arbitrary chrome, so a blind
 * Escape + corner click used to open "Your changes may be lost" itself.
 * Modals and message boxes are left alone for the model to answer.
 */
const DROPDOWN_ATTR = 'data-baix-covering-dropdown'
const DROPDOWN_SETTLE_MS = 100

async function dismissBlockingDropdown(
  owner: ClickTarget,
  offset: { x: number; y: number },
): Promise<DropdownDismissal> {
  const none: DropdownDismissal = { detected: false, closed: false }
  // No named inner functions in page code: the bundler rewrites them into
  // `__name` calls that do not exist in the page.
  const label = await owner
    .evaluate(
      (target, args) => {
        const doc = target.ownerDocument
        const win = doc.defaultView ?? window
        const rect = target.getBoundingClientRect()
        const hit = doc.elementFromPoint(
          rect.left + args.off.x,
          rect.top + args.off.y,
        )
        if (!hit || hit === target || target.contains(hit)) return null
        const modalClass = /\b(x-window|x-message-box|x-mask|modal)\b/
        const dropdownClass =
          /\b(dropdown|boundlist|datepicker|picker|autocomplete|suggestions|popover|menu-list|option-list)\b/
        let dropdown: Element | null = null
        for (
          let el: Element | null = hit;
          el && el !== doc.body;
          el = el.parentElement
        ) {
          const role = el.getAttribute('role') || ''
          const cls =
            typeof el.className === 'string' ? el.className.toLowerCase() : ''
          if (
            el.tagName === 'DIALOG' ||
            role === 'dialog' ||
            role === 'alertdialog' ||
            el.getAttribute('aria-modal') === 'true' ||
            modalClass.test(cls)
          ) {
            return null
          }
          let isDropdown =
            role === 'listbox' ||
            role === 'menu' ||
            role === 'tree' ||
            el.tagName === 'SELECT' ||
            el.tagName === 'DATALIST' ||
            dropdownClass.test(cls)
          if (!isDropdown) {
            const style = win.getComputedStyle(el)
            const z = Number.parseInt(style.zIndex, 10)
            isDropdown =
              (style.position === 'absolute' || style.position === 'fixed') &&
              Number.isFinite(z) &&
              z > 10 &&
              el.querySelector(
                '[role="option"], [role="menuitem"], option, li',
              ) !== null
          }
          if (isDropdown) {
            dropdown = el
            break
          }
        }
        if (!dropdown || dropdown.contains(target)) return null
        dropdown.setAttribute(args.attr, '')
        return (
          dropdown.getAttribute('aria-label') ||
          dropdown.getAttribute('role') ||
          dropdown.tagName.toLowerCase()
        ).slice(0, 60)
      },
      { off: offset, attr: DROPDOWN_ATTR },
    )
    .catch(() => null)
  if (label === null) return none

  const gone = () =>
    owner
      .evaluate((target, attr) => {
        const doc = target.ownerDocument
        const win = doc.defaultView ?? window
        const el = doc.querySelector(`[${attr}]`)
        if (!el || !el.isConnected) return true
        const style = win.getComputedStyle(el)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0
        ) {
          return true
        }
        // ExtJS hides pickers by moving them offscreen, not display:none.
        const box = el.getBoundingClientRect()
        return (
          (box.width === 0 && box.height === 0) ||
          box.right <= 0 ||
          box.bottom <= 0 ||
          box.left >= win.innerWidth ||
          box.top >= win.innerHeight
        )
      }, DROPDOWN_ATTR)
      .catch(() => false)

  const settle = () => new Promise<void>(r => setTimeout(r, DROPDOWN_SETTLE_MS))
  let result: DropdownDismissal = {
    detected: true,
    closed: false,
    dropdown: label,
  }
  try {
    await owner.evaluate(target => {
      const doc = target.ownerDocument
      const win = doc.defaultView ?? window
      for (const type of ['mousedown', 'mouseup', 'click']) {
        doc.body.dispatchEvent(
          new win.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: win,
            clientX: 0,
            clientY: 0,
          }),
        )
      }
    }, undefined)
    await settle()
    if (await gone()) {
      result = { ...result, closed: true, method: 'click-body' }
      return result
    }
    // Non-bubbling: the owning field's key handler sees it, a document-level
    // "cancel form" handler does not.
    const sent = await owner.evaluate((target, attr) => {
      const doc = target.ownerDocument
      const win = doc.defaultView ?? window
      const field = doc.activeElement
      const dropdown = doc.querySelector(`[${attr}]`)
      if (!field || field === doc.body || dropdown?.contains(field)) {
        return false
      }
      field.dispatchEvent(
        new win.KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: false,
          cancelable: true,
        }),
      )
      return true
    }, DROPDOWN_ATTR)
    if (sent) {
      await settle()
      if (await gone()) {
        result = { ...result, closed: true, method: 'escape-on-field' }
      }
    }
    return result
  } catch {
    return result
  } finally {
    await owner
      .evaluate((target, attr) => {
        target.ownerDocument.querySelector(`[${attr}]`)?.removeAttribute(attr)
      }, DROPDOWN_ATTR)
      .catch(() => {})
  }
}

async function pointHitsTarget(
  target: ClickTarget,
  offset: { x: number; y: number },
): Promise<boolean> {
  return target
    .evaluate((el, position) => {
      const rect = el.getBoundingClientRect()
      const x = rect.left + position.x
      const y = rect.top + position.y
      let top = document.elementFromPoint(x, y)
      if (!top) return false
      // Deep hit test for controls inside open shadow roots.
      while ((top as HTMLElement).shadowRoot) {
        const inner = (top as HTMLElement).shadowRoot!.elementFromPoint(x, y)
        if (!inner || inner === top) break
        top = inner
      }
      let current: Node | null = top
      while (current) {
        if (current === el) return true
        const root = current.getRootNode()
        current =
          current.parentNode ?? (root instanceof ShadowRoot ? root.host : null)
      }
      return false
    }, offset)
    .catch(() => false)
}

async function visibleFragmentCenter(
  target: ClickTarget,
): Promise<{ x: number; y: number } | undefined> {
  return target
    .evaluate(el => {
      const bounds = el.getBoundingClientRect()
      const clientRects = Array.from(el.getClientRects())
      // Preserve the long-tested bounding-box path for ordinary elements.
      // Fragment selection is only needed for wrapped inline content, whose
      // union bounding box can include points that belong to other elements.
      if (clientRects.length <= 1) return undefined
      const fragments = clientRects
        .map(rect => {
          const left = Math.max(0, rect.left)
          const top = Math.max(0, rect.top)
          const right = Math.min(innerWidth, rect.right)
          const bottom = Math.min(innerHeight, rect.bottom)
          return {
            left,
            top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
          }
        })
        .filter(rect => rect.width > 0 && rect.height > 0)
        .sort((a, b) => b.width * b.height - a.width * a.height)
      const best = fragments[0]
      if (!best) return undefined
      return {
        x: best.left + best.width / 2 - bounds.left,
        y: best.top + best.height / 2 - bounds.top,
      }
    }, undefined)
    .catch(() => undefined)
}

type ClickProbeState = 'seen' | 'pending' | 'missing'

/**
 * The probe is read through the handle captured when arming, so an option or
 * picker removed by its own click answers at once instead of a locator
 * waiting for it to reappear. The cap only guards a stalled relay.
 */
const CLICK_PROBE_EVAL_TIMEOUT_MS = 1_000

interface ClickProbe {
  handle: ElementHandle
  key: string
  ownsHandle: boolean
}

function withProbeTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>(resolve => {
      timer = setTimeout(() => resolve(fallback), CLICK_PROBE_EVAL_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function armClickProbe(
  loc: Locator,
  shared?: ElementHandle,
): Promise<ClickProbe | undefined> {
  const handle =
    shared ??
    (await loc
      .elementHandle({ timeout: CLICK_PROBE_EVAL_TIMEOUT_MS })
      .catch(() => null))
  if (!handle) return undefined
  const ownsHandle = !shared
  const key = `__aiAgentClickProbe_${Math.random().toString(36).slice(2)}`
  const armed = await withProbeTimeout(
    handle.evaluate((el, probeKey) => {
      const target = el as unknown as Element & Record<string, unknown>
      const probe = {
        seen: false,
        listeners: [] as Array<{
          type: 'pointerdown' | 'click'
          listener: EventListener
        }>,
        timer: 0,
      }
      const listen = (type: 'pointerdown' | 'click') => {
        const listener: EventListener = event => {
          if (event.composedPath().includes(el)) probe.seen = true
        }
        probe.listeners.push({ type, listener })
        window.addEventListener(type, listener, { capture: true })
      }
      listen('pointerdown')
      listen('click')
      probe.timer = window.setTimeout(() => {
        for (const { type, listener } of probe.listeners) {
          window.removeEventListener(type, listener, { capture: true })
        }
        delete target[probeKey]
      }, 10_000)
      target[probeKey] = probe
      return true
    }, key),
    false,
  )
  if (armed) return { handle, key, ownsHandle }
  if (ownsHandle) void handle.dispose().catch(() => {})
  return undefined
}

/**
 * Removes the listeners unless the click is still pending, so a pending probe
 * stays armed for the Enter retry. `force` always removes them.
 */
async function readClickProbe(
  probe: ClickProbe,
  force: boolean,
): Promise<ClickProbeState> {
  return withProbeTimeout<ClickProbeState>(
    probe.handle.evaluate(
      (el, args) => {
        const target = el as unknown as Element & Record<string, unknown>
        const state = target[args.key] as
          | {
              seen: boolean
              listeners: Array<{
                type: 'pointerdown' | 'click'
                listener: EventListener
              }>
              timer: number
            }
          | undefined
        if (!state) return 'missing'
        const result: ClickProbeState = state.seen
          ? 'seen'
          : el.isConnected
            ? 'pending'
            : 'missing'
        if (args.force || result !== 'pending') {
          for (const { type, listener } of state.listeners) {
            window.removeEventListener(type, listener, { capture: true })
          }
          clearTimeout(state.timer)
          delete target[args.key]
        }
        return result
      },
      { key: probe.key, force },
    ),
    // Navigation, removal, or replacement after the action is itself evidence
    // that the click was delivered; only a still-pending probe is a failure.
    'missing',
  )
}

async function canActivateWithEnter(loc: Locator): Promise<boolean> {
  return loc
    .evaluate(
      el => {
        const node = el as HTMLElement
        const tag = node.tagName.toLowerCase()
        if (tag === 'button') return !node.hasAttribute('disabled')
        if (tag === 'a') return node.hasAttribute('href')
        if (tag === 'input') {
          return /^(button|submit|reset|image)$/i.test(
            (node as HTMLInputElement).type,
          )
        }
        return node.getAttribute('role') === 'button'
      },
      undefined,
      { timeout: 1_000 },
    )
    .catch(() => false)
}

/**
 * chrome.debugger can acknowledge root-session mouse input that only focuses
 * a sandboxed OOPIF instead of reaching its control. Observe the actual click;
 * for keyboard-activatable controls, retry with trusted Enter input.
 */
async function performVerifiedClick(
  loc: Locator,
  click: () => Promise<void>,
  shared?: ElementHandle,
): Promise<void> {
  const probe = await timed('armProbe', () => armClickProbe(loc, shared))
  try {
    try {
      await timed('playwrightClick', click)
    } catch (err) {
      if (probe) await readClickProbe(probe, true)
      throw err
    }
    if (!probe) return

    const first = await timed('readProbe', () => readClickProbe(probe, false))
    noteClick('probe', first)
    if (first !== 'pending') return
    noteClick('enterRetry', true)
    if (await canActivateWithEnter(loc)) {
      await loc.focus({ timeout: 8_000 })
      await loc.press('Enter', { timeout: 8_000 })
      const retried = await readClickProbe(probe, true)
      if (retried !== 'pending') return
    } else {
      await readClickProbe(probe, true)
    }
  } finally {
    if (probe?.ownsHandle) void probe.handle.dispose().catch(() => {})
  }
  throw new BrowserError(
    'The browser acknowledged the mouse input, but no click reached the target. ' +
      'The control may be inside a sandboxed frame that rejected root-session mouse input. ' +
      'Capture a new snapshot and retry.',
  )
}

export interface ClickIntercept {
  blockingType: string
  interceptedBy: string
  interceptedRef?: string
  error: string
  suggestion: string
}

export function formatClickIntercept(hit: ClickIntercept): string {
  const lines = [hit.error, hit.suggestion]
  if (hit.interceptedRef) {
    lines.push(
      `Intercepted by: ${hit.interceptedBy} [ref=${hit.interceptedRef}]`,
    )
    lines.push(
      `Recovery action: browser_click with ref "${hit.interceptedRef}" if that is the overlay, or browser_snapshot`,
    )
  } else {
    lines.push(`Intercepted by: ${hit.interceptedBy}`)
    lines.push('Recovery action: browser_snapshot')
  }
  return lines.join('\n')
}

export async function diagnoseClickIntercept(
  _page: Page,
  loc: Locator,
  offsetX: number,
  offsetY: number,
): Promise<ClickIntercept | undefined> {
  const intercept = await loc
    .evaluate(
      (target, offset) => {
        const rect = target.getBoundingClientRect()
        const hit = document.elementFromPoint(
          rect.left + offset.x,
          rect.top + offset.y,
        ) as HTMLElement | null
        if (!hit) {
          return {
            blockingType: 'outside-viewport',
            interceptedBy: 'nothing (coordinates outside viewport)',
            error: 'Click coordinates are outside the visible viewport.',
            suggestion: 'Scroll the target into view, then snapshot and retry.',
          }
        }
        if (target === hit || target.contains(hit)) return null

        let current: HTMLElement | null = hit
        while (current && current !== target && current !== document.body) {
          const tag = current.tagName?.toLowerCase() || ''
          const role = current.getAttribute?.('role') || ''
          const style = window.getComputedStyle(current)
          const zIndex = parseInt(style.zIndex, 10)
          const hasHighZ = !Number.isNaN(zIndex) && zIndex > 100
          const isFixed =
            style.position === 'fixed' || style.position === 'absolute'
          const hitRef =
            current.getAttribute('aria-ref') ||
            current.getAttribute('data-cursor-ref') ||
            undefined
          const name = (
            current.getAttribute('aria-label') ||
            current.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60)
          const interceptedBy = role
            ? `${tag} role=${role}${name ? ` "${name}"` : ''}`
            : `${tag}${name ? ` "${name}"` : ''}`

          if (tag === 'iframe') {
            return {
              blockingType: 'iframe',
              interceptedBy,
              interceptedRef: hitRef,
              error: 'Click would hit an iframe instead of the target element.',
              suggestion:
                'Snapshot again — iframe controls use refs like f1e5. Click the inner control, not the iframe chrome.',
            }
          }
          const className =
            typeof current.className === 'string' ? current.className : ''
          if (
            tag === 'dialog' ||
            role === 'dialog' ||
            role === 'alertdialog' ||
            current.getAttribute('aria-modal') === 'true' ||
            /\b(x-window|x-message-box)\b/.test(className)
          ) {
            return {
              blockingType: 'modal',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit a modal/dialog instead of the target element.',
              suggestion:
                'Answer the dialog by clicking one of its own buttons (read its text first: on "unsaved changes" prompts, No/Cancel may discard the form or leave the page). Do not press Escape — some apps treat it as "cancel edit". Then snapshot and retry the original control.',
            }
          }
          if (
            (tag === 'nav' ||
              tag === 'header' ||
              role === 'navigation' ||
              role === 'banner') &&
            isFixed
          ) {
            return {
              blockingType: 'fixed-header',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit a fixed header/navigation bar instead of the target.',
              suggestion:
                'Scroll so the target is not behind the header, or click the header control if that was the intent.',
            }
          }
          if (hasHighZ && isFixed) {
            return {
              blockingType: 'overlay',
              interceptedBy,
              interceptedRef: hitRef,
              error:
                'Click would hit an overlay instead of the target element.',
              suggestion:
                'Snapshot to see what the overlay is. If it is a dialog or message box, click one of its buttons; if it is a dropdown, pick an option or click the field it belongs to. Do not press Escape — some apps treat it as "cancel edit".',
            }
          }
          current = current.parentElement
        }

        const otherRef =
          hit.getAttribute('aria-ref') ||
          hit.getAttribute('data-cursor-ref') ||
          undefined
        const otherName = (
          hit.getAttribute('aria-label') ||
          hit.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
        const otherTag = hit.tagName?.toLowerCase() || 'element'
        const otherRole = hit.getAttribute('role') || ''
        return {
          blockingType: 'other',
          interceptedBy: otherRole
            ? `${otherTag} role=${otherRole}${otherName ? ` "${otherName}"` : ''}`
            : `${otherTag}${otherName ? ` "${otherName}"` : ''}`,
          interceptedRef: otherRef,
          error: 'Click would hit a different element than the target.',
          suggestion:
            'Snapshot to see what is covering the control, then click that overlay or a new ref.',
        }
      },
      { x: offsetX, y: offsetY },
    )
    .catch(() => undefined)
  return intercept ?? undefined
}

export async function resolveClickTarget(
  page: Page,
  targetId: string,
  ref: string,
  element?: string,
  opts?: {
    retryOnStaleRef?: boolean
    refreshSnapshot?: () => Promise<void>
  },
): Promise<{ loc: Locator; ref: string; described: DescribedElement }> {
  const normalized = normalizeRef(ref)
  const retry = opts?.retryOnStaleRef !== false
  const knownBefore = getRefMeta(targetId, normalized)
  const hint =
    element?.trim() ||
    (knownBefore?.name
      ? `${knownBefore.role} "${knownBefore.name}"`
      : undefined)

  const tryRef = async (candidate: string) => {
    const loc = await targetLocator(page, { ref: candidate })
    const described = await describeElement(loc, candidate)
    assertElementHint(described, element, candidate)
    return { loc, ref: candidate, described }
  }

  try {
    return await tryRef(normalized)
  } catch (err) {
    if (!(err instanceof StaleRefError) || !retry) throw err
    if (opts?.refreshSnapshot) await opts.refreshSnapshot()
    try {
      return await tryRef(normalized)
    } catch (err2) {
      if (!(err2 instanceof StaleRefError)) throw err2
    }
    const recovered = recoverRefByHint(
      targetId,
      normalized,
      hint,
      knownBefore?.role,
    )
    if (!recovered || recovered === normalized) throw err
    return tryRef(recovered)
  }
}

export interface RobustClickOpts {
  button?: 'left' | 'right' | 'middle'
  doubleClick?: boolean
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
  offsetX?: number
  offsetY?: number
  force?: boolean
  maxScrollAttempts?: number
  retryOnStaleRef?: boolean
  autoCloseDropdowns?: boolean
  retryWithOffset?: boolean
}

export async function clickLocatorRobust(
  page: Page,
  loc: Locator,
  opts: RobustClickOpts,
): Promise<void> {
  const handle = await timed('resolveHandle', () =>
    loc.elementHandle({ timeout: TARGET_EVAL_TIMEOUT_MS }).catch(() => null),
  )
  const target = handle ? handleTarget(loc, handle) : locatorTarget(loc)
  try {
    await clickTargetRobust(page, loc, target, opts)
  } finally {
    if (handle) void handle.dispose().catch(() => {})
  }
}

async function clickTargetRobust(
  page: Page,
  loc: Locator,
  target: ClickTarget,
  opts: RobustClickOpts,
): Promise<void> {
  const maxScroll = opts.maxScrollAttempts ?? DEFAULT_MAX_SCROLL_ATTEMPTS
  const attempted: string[] = [
    `scrolled into view (up to ${maxScroll} attempts)`,
  ]
  const { box, viewport } = await timed('ensureInView', () =>
    ensureTargetInView(target, page, maxScroll),
  )

  const geometryStart = performance.now()
  const fragmentCenter =
    opts.offsetX === undefined && opts.offsetY === undefined
      ? await visibleFragmentCenter(target)
      : undefined
  const preferredPosition = {
    x: opts.offsetX ?? fragmentCenter?.x ?? box.width / 2,
    y: opts.offsetY ?? fragmentCenter?.y ?? box.height / 2,
  }
  const position = visibleClickPosition(box, viewport, preferredPosition)
  recordPhase('geometry', geometryStart)
  const clickArgs = {
    timeout: 8_000,
    button: opts.button,
    modifiers: opts.modifiers,
    force: opts.force,
    position,
  }

  const performClick = async (args: typeof clickArgs = clickArgs) => {
    if (
      opts.doubleClick ||
      opts.button === 'right' ||
      opts.button === 'middle'
    ) {
      if (opts.doubleClick) await loc.dblclick(args)
      else await loc.click(args)
      return
    }
    await performVerifiedClick(loc, () => loc.click(args), target.liveHandle())
  }

  if (opts.force) {
    await performClick()
    return
  }

  // Once our own hit test passed, Playwright's stable check only adds a
  // requestAnimationFrame wait, which takes ~1.5s when Chrome is occluded.
  // `force` drops every actionability check though, its own hit-target check
  // included, so a layer that slides over the target between our hit test and
  // the click takes the click; the click probe then reports it as undelivered.
  // Disabled targets keep the normal path so Playwright waits for enabled.
  const performCheckedClick = async (
    pos: { x: number; y: number } = position,
  ) => {
    const enabled = await timed('enabledCheck', () =>
      target.isEnabled().catch(() => false),
    )
    noteClick('skipStableWait', enabled)
    await performClick({ ...clickArgs, position: pos, force: enabled })
  }

  let hits = await timed('hitTest', () => pointHitsTarget(target, position))
  if (!hits && (await target.dropDetachedHandle())) {
    noteClick('handleDetached', true)
    hits = await pointHitsTarget(target, position)
  }
  noteClick('hitTest', hits)
  if (hits) {
    await performCheckedClick()
    return
  }

  if (opts.autoCloseDropdowns !== false) {
    const dismissal = await timed('dismissDropdown', () =>
      dismissBlockingDropdown(target, position),
    )
    if (dismissal.detected) {
      noteClick('dropdownDismissal', dismissal)
      const which = dismissal.dropdown ? ` (${dismissal.dropdown})` : ''
      attempted.push(
        dismissal.closed
          ? `closed the covering dropdown${which} via ${dismissal.method}`
          : `the covering dropdown${which} did not close`,
      )
      if (dismissal.closed && (await pointHitsTarget(target, position))) {
        await performCheckedClick()
        return
      }
    }
  }

  if (opts.retryWithOffset !== false) {
    noteClick('offsetRetry', true)
    attempted.push('offset click retries')
    const offsets = [
      { x: box.width * 0.25, y: box.height * 0.5 },
      { x: box.width * 0.75, y: box.height * 0.5 },
      { x: box.width * 0.5, y: box.height * 0.25 },
      { x: box.width * 0.5, y: box.height * 0.75 },
    ]
    for (const off of offsets) {
      if (!(await pointHitsTarget(target, off))) continue
      const retryArgs = { ...clickArgs, position: off }
      if (opts.doubleClick) await loc.dblclick(retryArgs)
      else await loc.click(retryArgs)
      return
    }
  }

  const intercept = await diagnoseClickIntercept(
    page,
    loc,
    position.x,
    position.y,
  )
  if (intercept) {
    throw new BrowserError(
      `Already tried: ${attempted.join('; ')}.\n${formatClickIntercept(intercept)}`,
    )
  }
  await performClick()
}
