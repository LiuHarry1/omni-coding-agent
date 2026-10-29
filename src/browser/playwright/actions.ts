/**
 * Acting on a ref: `page.locator('aria-ref=eN')` plus Playwright's actionability
 * checks and trusted input — aligned with Playwright MCP's `targetLocator` flow.
 *
 * Elements are described *before* the action, not after. A button that says
 * "Clicked 0 times" says "Clicked 1 times" once you press it, and reporting the
 * after-state names something the model never chose — worse, an action that
 * navigates away leaves nothing to describe at all.
 */

import type { Locator, Page } from 'playwright-core'
import { ensureScript } from '../page-inspect.js'
import {
  ACTION_TIMEOUT_MS,
  ACT_MAX_VIEWPORT_DIMENSION,
  NAVIGATE_SETTLE_MS,
  NAVIGATE_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
} from '../limits.js'
import {
  BrowserError,
  type BrowserBackend,
  type ResolvedElement,
} from '../types.js'
import { DATE_RANGE_CALENDAR_MSG, isTypedDateRange } from './fields.js'
import {
  editableLocator,
  mapPlaywrightError,
  normalizeRef,
  targetLocator,
} from './locator.js'
import { pickValue } from './pick.js'
import {
  allowBeforeUnloadForNavigation,
  handleDialog,
  peekDialog,
  throwIfUnarmedDestructiveDialog,
  uploadFiles,
} from './overlays.js'
import { settleIfUrlChanged, withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'
import { clearTabMemory, setTabPoisoned } from '../session-flags.js'
import { assertNavigateUrl } from '../navigate-policy.js'
import {
  clearViewportScreenshot,
  getViewportScreenshot,
} from '../viewport-screenshot-cache.js'
import {
  ensureSnapshotFresh,
  forceRefreshSnapshot,
  withHeavyMediaHidden,
} from './snapshot.js'
import {
  clickLocatorRobust,
  ensureInView,
  resolveClickTarget,
  type RobustClickOpts,
} from './robust-click.js'
import {
  ensureTabFocus,
  withInputFocus,
  withReadBoost,
  withVisualFocus,
} from './focus.js'
import { captureViewport } from './viewport-capture.js'
import type { ScrollExtent, ScrollOutcome } from '../scroll-report.js'

const NAVIGATION_STATE_VERIFY_TIMEOUT_MS = 2_000
const NAVIGATION_STOP_VERIFY_TIMEOUT_MS = 2_000
const NAVIGATION_STOP_POLL_MS = 100

function navigationAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  return reason instanceof Error
    ? reason
    : new BrowserError('Navigation interrupted by user.')
}

function throwIfActionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error
    ? reason
    : new BrowserError('Browser action interrupted by user.')
}

async function verifyCompletedNavigation(
  page: Page,
): Promise<{ readyState: string; timeOrigin: number } | undefined> {
  let timer: number | undefined
  try {
    return await Promise.race([
      page
        .evaluate<{ readyState: string; timeOrigin: number }>(
          '({ readyState: document.readyState, timeOrigin: performance.timeOrigin })',
        )
        .catch(() => undefined),
      new Promise<undefined>(resolve => {
        timer = setTimeout(resolve, NAVIGATION_STATE_VERIFY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A failed Chromium navigation can keep transitioning to chrome-error:// after
 * Playwright has already rejected page.goto(). Do not let that late transition
 * interrupt the next browser_navigate call. We wait for did-stop-loading
 * before applying the next URL and force-stop a navigation that does not
 * settle.
 */
async function stopFailedNavigation(
  backend: BrowserBackend,
  targetId: string,
  page: Page,
): Promise<boolean> {
  const waitForStableUrl = async (): Promise<boolean> => {
    const deadline = Date.now() + NAVIGATION_STOP_VERIFY_TIMEOUT_MS
    let previousUrl = page.url()
    let stableSamples = 0
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, NAVIGATION_STOP_POLL_MS))
      const currentUrl = page.url()
      if (currentUrl === previousUrl) {
        stableSamples += 1
      } else {
        previousUrl = currentUrl
        stableSamples = 0
      }
      if (stableSamples >= 2) return true
    }
    return false
  }

  try {
    await backend.send(targetId, 'Page.stopLoading')
    if (await waitForStableUrl()) return true

    // Some extension-driven redirect loops continue alternating error URLs
    // after stopLoading acknowledges. We do not have the next request yet, so
    // move to a neutral document and leave the tab reusable.
    await backend.send(targetId, 'Page.navigate', { url: 'about:blank' })
    return await waitForStableUrl()
  } catch {
    return false
  }
}

function staleRecovery(
  backend: BrowserBackend,
  targetId: string,
  retryOnStaleRef?: boolean,
) {
  return {
    retryOnStaleRef: retryOnStaleRef !== false,
    refreshSnapshot: () => forceRefreshSnapshot(backend, targetId),
  }
}

export async function navigate(
  backend: BrowserBackend,
  targetId: string,
  dest: { url: string },
  signal?: AbortSignal,
): Promise<void> {
  await ensureScript(backend, targetId)
  await withReadBoost(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const beforeUrl = page.url()
    const beforeTimeOrigin = await page
      .evaluate<number>('performance.timeOrigin')
      .catch(() => undefined)
    const stopLoading = () => {
      void backend.send(targetId, 'Page.stopLoading').catch(() => {})
    }
    if (signal?.aborted) {
      stopLoading()
      throw navigationAbortError(signal)
    }
    const clearBeforeUnloadAllowance = allowBeforeUnloadForNavigation(page)
    signal?.addEventListener('abort', stopLoading, { once: true })
    try {
      try {
        const href = assertNavigateUrl(dest.url)
        await page.goto(href, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATE_TIMEOUT_MS,
        })
      } catch (err) {
        if (signal?.aborted) {
          throw navigationAbortError(signal)
        }
        const message = err instanceof Error ? err.message : String(err)
        if (/Timeout/i.test(message)) {
          // Synthetic CDP endpoints can miss the lifecycle event Playwright is
          // awaiting even though Chrome completed the navigation. Verify the
          // resulting document before poisoning an otherwise healthy tab.
          const after = await verifyCompletedNavigation(page)
          const navigationCompleted =
            after !== undefined &&
            after.readyState !== 'loading' &&
            (page.url() !== beforeUrl ||
              (beforeTimeOrigin !== undefined &&
                after.timeOrigin !== beforeTimeOrigin))
          if (!navigationCompleted) {
            setTabPoisoned(targetId)
            throw new BrowserError(
              'Navigation timed out and the resulting page state could not be verified. ' +
                'This tab was marked unusable.\n' +
                'Recovery action: retry browser_navigate; it will open a fresh tab',
            )
          }
        } else {
          if (
            dest.url &&
            /interrupted by another navigation to "chrome-error:/i.test(message)
          ) {
            // A requested URL has to wait until the previous failed load
            // reaches did-stop-loading. Playwright has already issued this
            // request, so stop the late chrome-error transition and retry it
            // once on the same tab.
            await stopFailedNavigation(backend, targetId, page)
            await new Promise(resolve =>
              setTimeout(resolve, NAVIGATE_SETTLE_MS),
            )
            try {
              await page.goto(assertNavigateUrl(dest.url), {
                waitUntil: 'domcontentloaded',
                timeout: NAVIGATE_TIMEOUT_MS,
              })
              clearTabMemory(targetId)
              await new Promise(resolve =>
                setTimeout(resolve, NAVIGATE_SETTLE_MS),
              )
              if (signal?.aborted) throw navigationAbortError(signal)
              return
            } catch (retryErr) {
              setTabPoisoned(targetId)
              mapPlaywrightError(retryErr)
            }
          }
          await stopFailedNavigation(backend, targetId, page)
          mapPlaywrightError(err)
        }
      }
      clearTabMemory(targetId)
      await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
      if (signal?.aborted) throw navigationAbortError(signal)
    } finally {
      clearBeforeUnloadAllowance()
      signal?.removeEventListener('abort', stopLoading)
    }
  })
}

/** Make this tab the visible one and give a SPA a beat to refetch. */
export async function activateTab(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  await ensureTabFocus(backend, targetId, 'tab')
  await new Promise(r => setTimeout(r, NAVIGATE_SETTLE_MS))
}

async function afterNavigationLikeAction(
  page: Page,
  targetId: string,
  urlBefore: string,
): Promise<void> {
  await settleIfUrlChanged(page, urlBefore, targetId)
}

export async function click(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref?: string
    element?: string
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
    modifiers?: string[]
    force?: boolean
    offsetX?: number
    offsetY?: number
    maxScrollAttempts?: number
    retryOnStaleRef?: boolean
    autoCloseDropdowns?: boolean
    retryWithOffset?: boolean
    signal?: AbortSignal
  },
): Promise<ResolvedElement> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const modifiers = opts.modifiers as
      Array<'Alt' | 'Control' | 'Meta' | 'Shift'> | undefined
    const robust: RobustClickOpts = {
      button: opts.button,
      doubleClick: opts.doubleClick,
      modifiers,
      offsetX: opts.offsetX,
      offsetY: opts.offsetY,
      force: opts.force,
      maxScrollAttempts: opts.maxScrollAttempts,
      retryOnStaleRef: opts.retryOnStaleRef,
      autoCloseDropdowns: opts.autoCloseDropdowns,
      retryWithOffset: opts.retryWithOffset,
    }
    try {
      throwIfActionAborted(opts.signal)
      if (!opts.ref) {
        throw new BrowserError('Provide ref from the latest snapshot.')
      }
      await ensureSnapshotFresh(backend, targetId)
      const { loc, ref, described } = await resolveClickTarget(
        page,
        targetId,
        opts.ref,
        opts.element,
        staleRecovery(backend, targetId, opts.retryOnStaleRef),
      )
      const urlBefore = page.url()
      throwIfActionAborted(opts.signal)
      await withActionWait(page, async () => {
        await clickLocatorRobust(page, loc, robust)
      })
      throwIfActionAborted(opts.signal)
      throwIfUnarmedDestructiveDialog(page)
      await afterNavigationLikeAction(page, targetId, urlBefore)
      return { ...described, ref }
    } catch (err) {
      mapPlaywrightError(err, opts.ref)
    }
  })
}

export async function mouseClickXY(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    x: number
    y: number
    button?: 'left' | 'right' | 'middle'
    doubleClick?: boolean
  },
): Promise<
  ResolvedElement & {
    /** Tag, id, classes and leading text of the hit element, e.g. `<canvas id="cv">`. */
    preview: string
    screenshotCoordinates: { x: number; y: number }
    viewportCoordinates: { x: number; y: number }
  }
> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const screenshot = getViewportScreenshot(backend, targetId)
    if (!screenshot) {
      throw new BrowserError(
        'browser_mouse_click_xy needs a fresh viewport screenshot for this tab. ' +
          'Call browser_screenshot without labels or ref immediately before this tool; any other browser tool call invalidates it. ' +
          'Coordinates are pixels in that image, not label box values.',
      )
    }
    const screenshotX = Math.round(opts.x)
    const screenshotY = Math.round(opts.y)
    if (!Number.isFinite(screenshotX) || !Number.isFinite(screenshotY)) {
      throw new BrowserError('Coordinate click requires finite x and y values.')
    }
    if (
      screenshotX < 0 ||
      screenshotY < 0 ||
      screenshotX >= screenshot.sentImageWidth ||
      screenshotY >= screenshot.sentImageHeight
    ) {
      throw new BrowserError(
        `Coordinate (${screenshotX}, ${screenshotY}) is outside the latest screenshot ` +
          `${screenshot.sentImageWidth}x${screenshot.sentImageHeight}.`,
      )
    }
    if (page.url() !== screenshot.url) {
      clearViewportScreenshot(backend, targetId)
      throw new BrowserError(
        'browser_mouse_click_xy needs a fresh screenshot. The page URL changed since the latest screenshot.',
      )
    }
    const viewport =
      page.viewportSize() ??
      (await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })))
    if (
      viewport.width !== screenshot.viewportCssWidth ||
      viewport.height !== screenshot.viewportCssHeight
    ) {
      clearViewportScreenshot(backend, targetId)
      throw new BrowserError(
        'browser_mouse_click_xy needs a fresh screenshot. The viewport changed since the latest screenshot.',
      )
    }
    const x = Math.round(
      (screenshotX * screenshot.viewportCssWidth) / screenshot.sentImageWidth,
    )
    const y = Math.round(
      (screenshotY * screenshot.viewportCssHeight) / screenshot.sentImageHeight,
    )
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new BrowserError(
        `Coordinate (${x}, ${y}) is outside viewport ${viewport.width}x${viewport.height}.`,
      )
    }

    const hit = await page.evaluate(
      ({ x, y }) => {
        const target = document.elementFromPoint(x, y) as HTMLElement | null
        if (!target) return null
        const tag = target.tagName.toLowerCase()
        const name = (
          target.getAttribute('aria-label') ||
          target.getAttribute('title') ||
          target.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
        const attrs: string[] = []
        if (target.id) attrs.push(`id="${target.id}"`)
        if (typeof target.className === 'string' && target.className.trim()) {
          attrs.push(
            `class="${target.className.trim().split(/\s+/).slice(0, 2).join(' ')}"`,
          )
        }
        const role = target.getAttribute('role')
        if (role) attrs.push(`role="${role}"`)
        const text = name.slice(0, 30)
        return {
          target: {
            tag,
            role: role || 'generic',
            name,
            preview: `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${text ? '>' + text + (name.length > 30 ? '...' : '') : ''}>`,
          },
        }
      },
      { x, y },
    )
    if (!hit) {
      throw new BrowserError(
        `Coordinate (${x}, ${y}) does not hit a page element.`,
      )
    }

    const urlBefore = page.url()
    throwIfUnarmedDestructiveDialog(page)
    await withActionWait(page, () =>
      page.mouse.click(x, y, {
        button: opts.button,
        clickCount: opts.doubleClick ? 2 : 1,
      }),
    )
    throwIfUnarmedDestructiveDialog(page)
    await afterNavigationLikeAction(page, targetId, urlBefore)
    clearViewportScreenshot(backend, targetId)
    return {
      ref: '',
      role: hit.target.role,
      name: hit.target.name,
      tag: hit.target.tag,
      preview: hit.target.preview,
      screenshotCoordinates: { x: screenshotX, y: screenshotY },
      viewportCoordinates: { x, y },
    }
  })
}

export async function drag(
  backend: BrowserBackend,
  targetId: string,
  opts: { startRef: string; endRef: string },
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      await ensureSnapshotFresh(backend, targetId)
      const startFrame = normalizeRef(opts.startRef).match(/^(f\d+)?e\d+$/)?.[1]
      const endFrame = normalizeRef(opts.endRef).match(/^(f\d+)?e\d+$/)?.[1]
      if (startFrame !== endFrame) {
        throw new BrowserError(
          'Cross-frame drag is not supported. The drag source and target must belong to the same frame.',
        )
      }
      const start = await targetLocator(page, { ref: opts.startRef })
      const end = await targetLocator(page, { ref: opts.endRef })
      await ensureInView(start, page)
      const targetIsUnclipped = await end
        .evaluate(element => {
          const rect = element.getBoundingClientRect()
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.left >= innerWidth ||
            rect.top >= innerHeight
          ) {
            return false
          }
          let parent = element.parentElement
          while (parent) {
            const style = getComputedStyle(parent)
            const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX)
            const clipsY = /(auto|scroll|hidden|clip)/.test(style.overflowY)
            if (clipsX || clipsY) {
              const parentRect = parent.getBoundingClientRect()
              if (
                (clipsX &&
                  (rect.right <= parentRect.left ||
                    rect.left >= parentRect.right)) ||
                (clipsY &&
                  (rect.bottom <= parentRect.top ||
                    rect.top >= parentRect.bottom))
              ) {
                return false
              }
            }
            parent = parent.parentElement
          }
          return true
        })
        .catch(() => false)
      const urlBefore = page.url()
      await withActionWait(page, async () => {
        if (targetIsUnclipped) {
          await start.dragTo(end, { timeout: ACTION_TIMEOUT_MS })
          return
        }
        await dragToClippedTarget(page, start, end)
      })
      throwIfUnarmedDestructiveDialog(page)
      await afterNavigationLikeAction(page, targetId, urlBefore)
    } catch (err) {
      mapPlaywrightError(err, opts.startRef)
    }
  })
}

async function dragToClippedTarget(
  page: Page,
  start: Locator,
  end: Locator,
): Promise<void> {
  const source = await start.boundingBox({ timeout: ACTION_TIMEOUT_MS })
  if (!source) throw new BrowserError('Drag source is not visible.')
  const startX = source.x + source.width / 2
  const startY = source.y + source.height / 2
  const primeX = startX + Math.max(1, Math.min(8, source.width / 4))
  let mouseIsDown = false
  try {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    mouseIsDown = true
    // Start the native drag before scrolling moves the source out from under
    // the pointer. Playwright's dragTo scrolls the target first, so distant
    // targets in the same overflow container can otherwise report success
    // without ever dispatching dragstart/drop.
    await page.mouse.move(primeX, startY, { steps: 2 })
    await end.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
    const target = await end.boundingBox({ timeout: ACTION_TIMEOUT_MS })
    if (!target) throw new BrowserError('Drag target is not visible.')
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height / 2,
      { steps: 12 },
    )
    await page.mouse.up()
    mouseIsDown = false
  } finally {
    if (mouseIsDown) await page.mouse.up().catch(() => {})
  }
}

export async function hover(
  backend: BrowserBackend,
  targetId: string,
  opts: { ref: string; element?: string },
): Promise<ResolvedElement> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      await ensureSnapshotFresh(backend, targetId)
      const { loc, ref, described } = await resolveClickTarget(
        page,
        targetId,
        opts.ref,
        opts.element,
        staleRecovery(backend, targetId),
      )
      await withActionWait(page, async () => {
        await ensureInView(loc, page)
        await loc.hover({ timeout: ACTION_TIMEOUT_MS })
      })
      return { ...described, ref }
    } catch (err) {
      mapPlaywrightError(err, opts.ref)
    }
  })
}

export async function typeText(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref: string
    text: string
    slowly?: boolean
    submit?: boolean
    element?: string
    signal?: AbortSignal
  },
): Promise<ResolvedElement> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      throwIfActionAborted(opts.signal)
      await ensureSnapshotFresh(backend, targetId)
      const { loc, ref, described } = await resolveClickTarget(
        page,
        targetId,
        opts.ref,
        opts.element,
        staleRecovery(backend, targetId),
      )
      // A field the app computes rejects the write anyway. Returning its current
      // value makes the refusal visible instead of looking like a silent no-op.
      if (described.readOnly || described.disabled) return { ...described, ref }

      if (isTypedDateRange(described.name, opts.text)) {
        throw new BrowserError(DATE_RANGE_CALENDAR_MSG)
      }

      const writeLoc = editableLocator(loc, described.field)
      const value = await withActionWait(page, async () => {
        const timeout = ACTION_TIMEOUT_MS
        if (opts.slowly) {
          throwIfActionAborted(opts.signal)
          await writeLoc.click({ timeout })
          for (const character of Array.from(opts.text)) {
            throwIfActionAborted(opts.signal)
            await writeLoc.type(character, { timeout, delay: 75 })
          }
        } else {
          throwIfActionAborted(opts.signal)
          await writeLoc.fill(opts.text, { timeout })
        }
        throwIfActionAborted(opts.signal)
        if (opts.submit) {
          await writeLoc.press('Enter', { timeout })
          throwIfActionAborted(opts.signal)
        }
        return writeLoc
          .evaluate(node => {
            const t = node as HTMLInputElement
            return t.isContentEditable
              ? ((t as unknown as HTMLElement).innerText || '').trim()
              : (t.value ?? '')
          })
          .catch(() => opts.text)
      })
      throwIfActionAborted(opts.signal)
      throwIfUnarmedDestructiveDialog(page)
      return { ...described, ref, value }
    } catch (err) {
      mapPlaywrightError(err, opts.ref)
    }
  })
}

export async function selectOption(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  values: string[],
  element?: string,
): Promise<{ selected: string[] }> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      await ensureSnapshotFresh(backend, targetId)
      const { loc } = await resolveClickTarget(
        page,
        targetId,
        ref,
        element,
        staleRecovery(backend, targetId),
      )
      const selected = await withActionWait(page, () => pickValue(loc, values))
      throwIfUnarmedDestructiveDialog(page)
      return selected
    } catch (err) {
      mapPlaywrightError(err, ref)
    }
  })
}

export async function peekNativeDialog(
  backend: BrowserBackend,
  targetId: string,
): Promise<
  | { type: string; message: string; accepted: boolean; pending?: boolean }
  | undefined
> {
  const page = await getPageForTarget(backend, targetId)
  return peekDialog(page)
}

export async function handleNativeDialog(
  backend: BrowserBackend,
  targetId: string,
  opts: { accept: boolean; promptText?: string },
): Promise<{
  type: string
  message: string
  accepted: boolean
  armed?: boolean
}> {
  const page = await getPageForTarget(backend, targetId)
  try {
    return await handleDialog(page, opts)
  } catch (err) {
    mapPlaywrightError(err)
  }
}

export async function uploadFilesToPage(
  backend: BrowserBackend,
  targetId: string,
  opts: { paths: string[]; ref?: string },
): Promise<{ files: string[]; cancelled: boolean }> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      // No network drain: attaching a file often starts a PDF/viewer fetch that
      // never goes idle, and waiting for it is what made upload look hung.
      return await uploadFiles(page, opts)
    } catch (err) {
      mapPlaywrightError(err, opts.ref)
    }
  })
}

export async function pressKey(
  backend: BrowserBackend,
  targetId: string,
  key: string,
  modifiers?: string[],
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const combo = [...(modifiers ?? []), key].join('+')
    try {
      await withActionWait(page, async () => {
        await page.keyboard.press(combo)
      })
      throwIfUnarmedDestructiveDialog(page)
    } catch (err) {
      mapPlaywrightError(err)
    }
  })
}

function resolveViewportDimension(
  value: unknown,
  label: 'width' | 'height',
): number {
  const dimension = Math.floor(Number(value))
  if (!Number.isFinite(dimension) || dimension < 1) {
    throw new BrowserError(`viewport ${label} must be >= 1`)
  }
  if (dimension > ACT_MAX_VIEWPORT_DIMENSION) {
    throw new BrowserError(
      `viewport ${label} exceeds maximum of ${ACT_MAX_VIEWPORT_DIMENSION}`,
    )
  }
  return dimension
}

export async function resizeViewport(
  backend: BrowserBackend,
  targetId: string,
  width: number,
  height: number,
): Promise<void> {
  const page = await getPageForTarget(backend, targetId)
  await page.setViewportSize({
    width: resolveViewportDimension(width, 'width'),
    height: resolveViewportDimension(height, 'height'),
  })
}

export async function scrollIntoView(
  backend: BrowserBackend,
  targetId: string,
  ref: string,
  element?: string,
): Promise<void> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      const loc = await targetLocator(page, { ref, element })
      await loc.scrollIntoViewIfNeeded({
        timeout: ACTION_TIMEOUT_MS,
      })
    } catch (err) {
      mapPlaywrightError(err, ref)
    }
  })
}

interface InPageScrollArgs {
  dx: number
  dy: number
  /** `page` falls back to the scroller under the viewport center; `container` needs one around the element. */
  mode: 'page' | 'container'
}

type InPageScrollResult =
  | { found: false }
  | {
      found: true
      container: boolean
      /** False when neither the page nor any container could move on the requested axes. */
      scrollable: boolean
      label: string
      moved: { x: number; y: number }
      extent: ScrollExtent
    }

/**
 * `scrollBy` instead of a wheel event: a wheel lands wherever the mouse happens
 * to be and returns before the scroll settles, so neither the target nor the
 * distance moved is knowable. No named inner functions: the bundler rewrites
 * them into `__name` calls that do not exist in the page.
 */
const SCROLL_IN_PAGE = (
  start: Element,
  a: InPageScrollArgs,
): InPageScrollResult => {
  const doc = start.ownerDocument
  const win = doc.defaultView || window
  const root = (doc.scrollingElement || doc.documentElement) as HTMLElement
  const wantX = a.dx !== 0
  const wantY = a.dy !== 0
  const pageX = root.scrollWidth > root.clientWidth + 1
  const pageY = root.scrollHeight > root.clientHeight + 1
  const pageMoves = (!wantX && !wantY) || (wantY && pageY) || (wantX && pageX)
  let from: Element | null = start
  if (a.mode === 'page') {
    from = pageMoves
      ? null
      : doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2)
  }
  let box: HTMLElement | null = null
  for (let el = from; el && el !== root; el = el.parentElement) {
    const style = win.getComputedStyle(el)
    const okY =
      wantY &&
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      el.scrollHeight > el.clientHeight + 1
    const okX =
      wantX &&
      /(auto|scroll|overlay)/.test(style.overflowX) &&
      el.scrollWidth > el.clientWidth + 1
    if (okY || okX) {
      box = el as HTMLElement
      break
    }
  }
  if (!box && a.mode === 'container') return { found: false }

  const beforeX = box ? box.scrollLeft : win.scrollX
  const beforeY = box ? box.scrollTop : win.scrollY
  if (wantX || wantY) {
    const by = { left: a.dx, top: a.dy, behavior: 'instant' as ScrollBehavior }
    if (box) box.scrollBy(by)
    else win.scrollBy(by)
  }
  const x = box ? box.scrollLeft : win.scrollX
  const y = box ? box.scrollTop : win.scrollY
  const m = box || root
  let label = ''
  if (box) {
    label = box.tagName.toLowerCase()
    if (box.id) label += '#' + box.id
    else if (typeof box.className === 'string' && box.className.trim()) {
      label += '.' + box.className.trim().split(/\s+/)[0]
    }
    const aria = box.getAttribute('aria-label')
    if (aria) label += ' "' + aria.slice(0, 40) + '"'
  }
  return {
    found: true,
    container: Boolean(box),
    scrollable: Boolean(box) || pageMoves,
    label,
    moved: { x: x - beforeX, y: y - beforeY },
    extent: {
      x,
      y,
      clientWidth: m.clientWidth,
      clientHeight: m.clientHeight,
      scrollWidth: m.scrollWidth,
      scrollHeight: m.scrollHeight,
    },
  }
}

/**
 * Scroll and report what actually moved (the browser_scroll contract):
 * no ref scrolls the page, a ref with a delta scrolls its nearest scrollable
 * container, and a ref alone is brought into view.
 */
export async function scroll(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    deltaX?: number
    deltaY?: number
    ref?: string
    scrollIntoView?: boolean
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
    element?: string
  },
): Promise<ScrollOutcome> {
  const amount = opts.amount ?? 300
  let deltaX = opts.deltaX ?? 0
  let deltaY = opts.deltaY ?? 0
  if (opts.direction === 'up') deltaY = -amount
  if (opts.direction === 'down') deltaY = amount
  if (opts.direction === 'left') deltaX = -amount
  if (opts.direction === 'right') deltaX = amount
  const hasDelta = deltaX !== 0 || deltaY !== 0
  const intoView = Boolean(opts.ref) && (opts.scrollIntoView ?? !hasDelta)
  if (!hasDelta && !intoView) {
    throw new BrowserError(
      'Nothing to scroll: pass direction (with optional amount) or deltaX/deltaY, or a ref to bring into view.\nRecovery action: browser_scroll with direction "down" or "up"',
    )
  }
  const requested = { x: deltaX, y: deltaY }

  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    try {
      if (!opts.ref) {
        const res = await page.locator(':root').evaluate(SCROLL_IN_PAGE, {
          dx: deltaX,
          dy: deltaY,
          mode: 'page' as const,
        })
        if (!res.found)
          throw new BrowserError('Could not read the page scroll position.')
        if (!res.scrollable) {
          await page.mouse.move(
            res.extent.clientWidth / 2,
            res.extent.clientHeight / 2,
          )
          await page.mouse.wheel(deltaX, deltaY)
          return {
            kind: 'wheel',
            requested,
            moved: { x: 0, y: 0 },
            extent: res.extent,
          }
        }
        return {
          kind: res.container ? 'container' : 'page',
          label: res.container ? res.label : undefined,
          requested,
          moved: res.moved,
          extent: res.extent,
        }
      }

      await ensureSnapshotFresh(backend, targetId)
      const { loc, ref, described } = await resolveClickTarget(
        page,
        targetId,
        opts.ref,
        opts.element,
        staleRecovery(backend, targetId),
      )
      if (intoView) {
        await ensureInView(loc, page)
        const res = await loc.evaluate(SCROLL_IN_PAGE, {
          dx: 0,
          dy: 0,
          mode: 'page' as const,
        })
        if (!res.found)
          throw new BrowserError('Could not read the page scroll position.')
        return {
          kind: 'into-view',
          label: described.name
            ? `${described.role} "${described.name}"`
            : described.role,
          requested,
          moved: { x: 0, y: 0 },
          extent: res.extent,
        }
      }
      const res = await loc.evaluate(SCROLL_IN_PAGE, {
        dx: deltaX,
        dy: deltaY,
        mode: 'container' as const,
      })
      if (!res.found) {
        throw new BrowserError(
          `${ref} is not inside a scrollable container. Omit ref to scroll the page, or pass scrollIntoView: true to bring it into view.\nRecovery action: browser_scroll without ref, or with scrollIntoView: true`,
        )
      }
      return {
        kind: 'container',
        label: res.label,
        requested,
        moved: res.moved,
        extent: res.extent,
      }
    } catch (err) {
      mapPlaywrightError(err, opts.ref)
    }
  })
}

export async function screenshot(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    ref?: string
    fullPage?: boolean
    format?: 'png' | 'jpeg'
    quality?: number
    element?: string
  } = {},
): Promise<{
  buffer: Buffer
  format: 'png' | 'jpeg'
  url: string
  viewport: { width: number; height: number }
}> {
  return withVisualFocus(backend, targetId, async () => {
    const page: Page = await getPageForTarget(backend, targetId)
    const format = opts.format ?? 'png'
    const quality = format === 'jpeg' ? { quality: opts.quality ?? 80 } : {}
    try {
      if (opts.ref && opts.fullPage) {
        throw new BrowserError(
          'fullPage is not supported for element screenshots.\n' +
            'Recovery action: retry browser_screenshot and remove either ref or fullPage',
        )
      }
      const take = async () =>
        opts.ref
          ? await (
              await targetLocator(page, {
                ref: opts.ref,
                element: opts.element,
              })
            ).screenshot({
              type: format,
              timeout: SCREENSHOT_TIMEOUT_MS,
              ...quality,
            })
          : opts.fullPage
            ? await page.screenshot({
                type: format,
                fullPage: true,
                timeout: SCREENSHOT_TIMEOUT_MS,
                ...quality,
              })
            : await captureViewport(backend, targetId, page, {
                type: format,
                ...quality,
              })
      // Same as snapshot: PDF/receipt iframes stall Chrome's compositor.
      const shot = await withHeavyMediaHidden(page, take)
      const viewport =
        page.viewportSize() ??
        (await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })))
      return { buffer: Buffer.from(shot), format, url: page.url(), viewport }
    } catch (err) {
      if (
        !opts.ref &&
        /Timeout|waiting/i.test(
          err instanceof Error ? err.message : String(err),
        )
      ) {
        throw new BrowserError(
          'Screenshot timed out (PDF/iframe receipt previews often stall it). Do not retry screenshot in a loop. Prefer a compact accessibility snapshot after the next form action, or keep filling visible form controls if they are already known.',
        )
      }
      mapPlaywrightError(err, opts.ref)
    }
  })
}
