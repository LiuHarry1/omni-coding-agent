/**
 * How the model sees the page: Playwright's own AI aria snapshot, with `eN`
 * refs stamped on the live DOM. Full trees stay complete; only
 * `mode=efficient` spends a char/node budget by priority.
 */

import type { Frame, Page } from 'playwright-core'
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_NODES,
  DEFAULT_SNAPSHOT_DEPTH,
  EFFICIENT_MAX_CHARS,
  MAX_SNAPSHOT_DEPTH,
  POST_ACTION_MAX_NODES,
  SNAPSHOT_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_MS,
  WAIT_FOR_TIME_CAP_S,
} from '../limits.js'
import {
  BrowserError,
  type BrowserBackend,
  type SnapshotOpts,
  type SnapshotResult,
} from '../types.js'
import {
  countRefs,
  dropRedundantWrapperNames,
  groupBadgeLabels,
  keepInteractive,
  prioritizeAriaSnapshot,
} from '../distill-snapshot.js'
import { isHeavyMediaFrame, SNAPSHOT_STALL_NEXT } from '../heavy-media.js'
import {
  getLastSnapshot,
  isSnapshotDegraded,
  isSnapshotStale,
  rememberSnapshot,
  setSnapshotDegraded,
} from '../session-flags.js'
import { filterSnapshotLines } from '../snapshot-index.js'
import {
  ariaRefCssSelectorMessage,
  isAriaRefCssSelector,
} from '../selector-guard.js'
import { getPageForTarget } from './connect.js'
import { withReadBoost } from './focus.js'
import { appendSnapshotUrls, type SnapshotUrlEntry } from '../snapshot-urls.js'

const DIALOG_SNAPSHOT_MS = 2_000
const DIALOG_SEARCH_MS = 3_500
const FRAME_QUERY_MS = 800
const DIALOG_PREFIX =
  'A modal dialog is covering the page. Click a control on this dialog before the page underneath.\n\n'
const DIALOG_NO_REF_PREFIX = `A modal is open but refs could not be stamped (PDF/iframe stalled the tree). ${SNAPSHOT_STALL_NEXT}\n`

/** CSS-scoped snapshot — OpenClaw-style: selector is CSS only, not aria-ref. */
async function scopedLocatorSnapshot(
  page: Page,
  selector: string,
  timeout: number,
): Promise<string> {
  const loc = page.locator(selector)
  const n = await loc.count().catch(() => 0)
  if (n === 0) return ''
  return loc.ariaSnapshot({ mode: 'ai', timeout }).catch(() => '')
}

function raceMs<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    work.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

const EMBEDDED_FRAME_OMIT_MS = 4_000
const HIDE_EVAL_MS = 1_500
const FRAMES_OMITTED_PREFIX =
  'Embedded frames omitted (they stalled the accessibility tree). Capture a new snapshot when the page is usable.\n\n'

/**
 * Playwright AI snapshots recurse into every iframe (`enter-frame`). display:none
 * does not stop that, so a PDF viewer still hangs the tree. We never enter
 * iframes. Detach heavy (or all) embeds for the duration of the capture.
 */
function collectSnapshotFrames(page: Page): Frame[] {
  const seen = new Set<Frame>()
  const out: Frame[] = []
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    if (seen.has(frame)) continue
    seen.add(frame)
    if (isHeavyMediaFrame(frame.url())) continue
    out.push(frame)
  }
  return out
}

async function hideByAttr(
  page: Page,
  attr: string,
  all: boolean,
): Promise<void> {
  await Promise.all(
    collectSnapshotFrames(page).map(frame =>
      raceMs(
        HIDE_EVAL_MS,
        frame
          .evaluate(
            ({ attr, all }) => {
              const storeKey = `__snapDetach_${attr}`
              const w = window as unknown as Record<string, unknown>
              type Slot = { el: Element; parent: Node; next: Node | null }
              const slots: Slot[] = []
              // A queue, not a recursive helper: named inner functions become
              // `__name` calls that do not exist in the page.
              const roots: ParentNode[] = [document]
              for (let r = 0; r < roots.length; r++) {
                const root = roots[r]
                const kids = root.querySelectorAll('iframe, embed, object')
                for (let i = 0; i < kids.length; i++) {
                  const el = kids[i]
                  const src =
                    el.getAttribute('src') || el.getAttribute('data') || ''
                  const type = el.getAttribute('type') || ''
                  const label = `${el.getAttribute('title') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''}`
                  const s = src.toLowerCase()
                  const t = type.toLowerCase()
                  const dialog = el.closest(
                    '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
                  )
                  const heavy =
                    all ||
                    t.includes('pdf') ||
                    s.includes('application/pdf') ||
                    /\.pdf(\b|$|\?|#)/.test(s) ||
                    s.startsWith('blob:') ||
                    s.startsWith('data:application/pdf') ||
                    s.includes('pdf.js') ||
                    s.includes('/pdfjs/') ||
                    /receiptimage|receipt-preview|\/receipts?\/|attachmentpreview|filepreview/.test(
                      s,
                    ) ||
                    (s.startsWith('chrome-extension://') &&
                      (s.includes('pdf') ||
                        s.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai'))) ||
                    /pdf|preview|viewer|receipt|attachment/i.test(label) ||
                    (dialog &&
                      (s === '' ||
                        s === 'about:blank' ||
                        /attach|receipt|preview|pdf/i.test(
                          dialog.textContent?.slice(0, 240) || '',
                        )))
                  if (!heavy) continue
                  if (!el.parentNode) continue
                  slots.push({
                    el,
                    parent: el.parentNode,
                    next: el.nextSibling,
                  })
                }
                const allEls = root.querySelectorAll('*')
                for (let i = 0; i < allEls.length; i++) {
                  const sr = (allEls[i] as HTMLElement).shadowRoot
                  if (sr) roots.push(sr)
                }
              }
              for (const slot of slots) {
                try {
                  slot.parent.removeChild(slot.el)
                } catch {
                  /* already gone */
                }
              }
              w[storeKey] = slots
            },
            { attr, all },
          )
          .then(() => undefined)
          .catch(() => undefined),
        undefined,
      ),
    ),
  )
}

async function unhideByAttr(page: Page, attr: string): Promise<void> {
  await Promise.all(
    collectSnapshotFrames(page).map(frame =>
      raceMs(
        HIDE_EVAL_MS,
        frame
          .evaluate(attr => {
            const storeKey = `__snapDetach_${attr}`
            const w = window as unknown as Record<string, unknown>
            const slots = w[storeKey] as
              { el: Element; parent: Node; next: Node | null }[] | undefined
            if (!Array.isArray(slots)) return
            for (let i = slots.length - 1; i >= 0; i--) {
              const slot = slots[i]
              try {
                if (slot.next && slot.next.parentNode === slot.parent) {
                  slot.parent.insertBefore(slot.el, slot.next)
                } else {
                  slot.parent.appendChild(slot.el)
                }
              } catch {
                /* parent gone */
              }
            }
            delete w[storeKey]
          }, attr)
          .then(() => undefined)
          .catch(() => undefined),
        undefined,
      ),
    ),
  )
}

const PARKED_ATTR = 'data-snap-parked'

/**
 * ExtJS and similar toolkits "hide" pickers and message boxes by moving them
 * to about (-10000, -10000) instead of display:none, so the accessibility
 * tree keeps a closed "Please Confirm" box or date picker forever and the
 * model keeps answering it. Nothing at negative page coordinates can be
 * scrolled into view, so hide those subtrees for the capture. Only
 * absolutely/fixed positioned boxes far past the origin qualify, so carousel
 * items and 1px screen-reader text are untouched, and taking them out of
 * layout moves nothing on screen. Playwright's AI snapshot keeps visible
 * aria-hidden nodes (it only drops their names), so display:none it is.
 */
async function markParkedOffscreen(page: Page): Promise<Frame[]> {
  // A still-loading frame (empty URL) never answers evaluate; waiting out the
  // cap twice per snapshot pushed hung-viewer pages past the snapshot budget.
  const frames = collectSnapshotFrames(page).filter(
    frame => !frame.isDetached() && frame.url() !== '',
  )
  const counts = await Promise.all(
    frames.map(frame =>
      raceMs(
        HIDE_EVAL_MS,
        frame.evaluate(attr => {
          const FAR = 500
          // RTL documents scroll into negative x down to this origin.
          const root = document.scrollingElement ?? document.documentElement
          const minX =
            window.getComputedStyle(document.documentElement).direction ===
            'rtl'
              ? root.clientWidth - root.scrollWidth
              : 0
          const all = document.body?.querySelectorAll('*') ?? []
          const parked: HTMLElement[] = []
          for (let i = 0; i < all.length; i++) {
            const el = all[i] as HTMLElement
            if (parked.some(p => p.contains(el))) continue
            const style = window.getComputedStyle(el)
            if (style.position !== 'absolute' && style.position !== 'fixed') {
              continue
            }
            if (style.display === 'none') continue
            const rect = el.getBoundingClientRect()
            if (rect.width <= 1 || rect.height <= 1) continue
            const right = rect.right + window.scrollX
            const bottom = rect.bottom + window.scrollY
            if (right > minX - FAR && bottom > -FAR) continue
            parked.push(el)
          }
          for (const el of parked) {
            const prev = el.style.getPropertyValue('display')
            const priority = el.style.getPropertyPriority('display')
            el.setAttribute(attr, JSON.stringify([prev, priority]))
            el.style.setProperty('display', 'none', 'important')
          }
          return parked.length
        }, PARKED_ATTR),
        // A timed-out evaluate can still apply display:none after the race,
        // so that frame must be unmarked too.
        -1,
      ),
    ),
  )
  return frames.filter((_, i) => counts[i] !== 0)
}

async function unmarkParkedOffscreen(frames: Frame[]): Promise<void> {
  await Promise.all(
    frames.map(frame =>
      raceMs(
        HIDE_EVAL_MS,
        frame
          .evaluate(attr => {
            for (const node of Array.from(
              document.querySelectorAll(`[${attr}]`),
            )) {
              const el = node as HTMLElement
              let prev = ''
              let priority = ''
              try {
                ;[prev, priority] = JSON.parse(el.getAttribute(attr) || '[]')
              } catch {
                /* keep defaults */
              }
              el.removeAttribute(attr)
              if (prev) el.style.setProperty('display', prev, priority)
              else el.style.removeProperty('display')
            }
          }, PARKED_ATTR)
          .then(() => undefined)
          .catch(() => undefined),
        undefined,
      ),
    ),
  )
}

async function withParkedOffscreenHidden<T>(
  page: Page,
  run: () => Promise<T>,
): Promise<T> {
  const marked = await markParkedOffscreen(page).catch(() => [] as Frame[])
  try {
    return await run()
  } finally {
    if (marked.length) await unmarkParkedOffscreen(marked).catch(() => {})
  }
}

export async function withHeavyMediaHidden<T>(
  page: Page,
  run: () => Promise<T>,
): Promise<T> {
  await hideByAttr(page, 'data-snap-hide', false).catch(() => {})
  try {
    return await run()
  } finally {
    await unhideByAttr(page, 'data-snap-hide').catch(() => {})
  }
}

/** Last-resort snapshot: skip every iframe/embed so a hung viewer cannot stall the tree. */
async function withEmbeddedFramesOmitted<T>(
  page: Page,
  run: () => Promise<T>,
): Promise<T> {
  await hideByAttr(page, 'data-snap-omit', true).catch(() => {})
  try {
    return await run()
  } finally {
    await unhideByAttr(page, 'data-snap-omit').catch(() => {})
  }
}

async function ariaSnapshotPage(
  page: Page,
  timeout: number,
  depth?: number,
): Promise<string> {
  return page.ariaSnapshot({
    mode: 'ai',
    timeout,
    ...(depth !== undefined ? { depth } : {}),
  })
}

/**
 * Actionable in-page alert box. Not `window.alert` (that is
 * `browser_handle_dialog`) and not a generic `role=dialog` panel.
 *
 * PDF/blob frames are skipped and every locator is time-capped: a hung
 * receipt viewer used to block this for the full 60s call budget, so the
 * model never saw the Yes/No box sitting on top of the form.
 *
 * This is only a fallback for an explicit dialog-only request or a failed
 * full-page snapshot. Normal snapshots keep the entire page. ExtJS moves
 * dismissed dialogs far offscreen while Playwright still reports them as
 * visible, so CSS visibility alone is not enough: the candidate must overlap
 * the viewport and win a real hit test.
 */
async function snapshotDialogInFrame(frame: Frame): Promise<string | null> {
  const alerts = frame.locator('[role="alertdialog"]')
  const n = await raceMs(
    FRAME_QUERY_MS,
    alerts.count().catch(() => 0),
    0,
  )
  for (let i = 0; i < n; i++) {
    const item = alerts.nth(i)
    const actionable = await raceMs(
      FRAME_QUERY_MS,
      item
        .evaluate(element => {
          const el = element as HTMLElement
          if (el.closest('[aria-hidden="true"], [inert]')) return false
          const style = window.getComputedStyle(el)
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          ) {
            return false
          }
          const rect = el.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const left = Math.max(0, rect.left)
          const top = Math.max(0, rect.top)
          const right = Math.min(window.innerWidth, rect.right)
          const bottom = Math.min(window.innerHeight, rect.bottom)
          if (right <= left || bottom <= top) return false
          const hit = document.elementFromPoint(
            (left + right) / 2,
            (top + bottom) / 2,
          )
          return hit === el || (hit !== null && el.contains(hit))
        })
        .catch(() => false),
      false,
    )
    if (!actionable) continue
    const yaml = await raceMs(
      DIALOG_SNAPSHOT_MS,
      item
        .ariaSnapshot({ mode: 'ai', timeout: DIALOG_SNAPSHOT_MS })
        .catch(() => ''),
      '',
    )
    if (yaml && countRefs(yaml) > 0) return yaml
    if (yaml) return DIALOG_NO_REF_PREFIX
  }
  return null
}

async function snapshotBlockingDialog(page: Page): Promise<string | null> {
  return raceMs(
    DIALOG_SEARCH_MS,
    (async () => {
      const frames: Frame[] = []
      const seen = new Set<Frame>()
      const consider = (frame: Frame) => {
        if (seen.has(frame)) return
        seen.add(frame)
        if (isHeavyMediaFrame(frame.url())) return
        frames.push(frame)
      }
      consider(page.mainFrame())
      for (const frame of page.frames()) consider(frame)

      for (const frame of frames) {
        const yaml = await snapshotDialogInFrame(frame)
        if (yaml) return yaml
      }
      return null
    })(),
    null,
  )
}

async function collectSnapshotUrls(page: Page): Promise<SnapshotUrlEntry[]> {
  // collectSnapshotUrls
  const urls = await page
    .evaluate(() => {
      const seen = new Set<string>()
      const out: SnapshotUrlEntry[] = []
      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : ''
        if (!href || seen.has(href)) {
          continue
        }
        const text =
          (anchor.textContent || anchor.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 121) || href
        seen.add(href)
        out.push({ text, url: href })
        if (out.length >= 100) {
          break
        }
      }
      return out
    })
    .catch(() => [])
  return Array.isArray(urls)
    ? urls.map(entry => {
        entry.text = entry.text.slice(0, 120) || entry.url
        return entry
      })
    : []
}

function recordSnapshotHealth(targetId: string, text: string): void {
  const degraded =
    text.includes(SNAPSHOT_STALL_NEXT) ||
    /Embedded frames omitted/i.test(text) ||
    text.startsWith('A modal is open but refs could not be stamped')
  if (degraded) {
    setSnapshotDegraded(targetId, true)
    return
  }
  if (/\[ref=/i.test(text)) {
    setSnapshotDegraded(targetId, false)
    rememberSnapshot(targetId, text)
  }
}

/**
 * Hold callers to the ceilings the tool descriptions already advertise.
 * Clamping rather than rejecting follows `getPageText`: an over-large budget
 * degrades to the cap instead of costing the model a turn on a schema error.
 * Non-positive values fall back to the defaults, since `?? EFFICIENT_MAX_CHARS`
 * would otherwise honour a literal 0 and snapshot nothing.
 */
function clampSnapshotOpts(opts: SnapshotOpts): SnapshotOpts {
  const clamp = (
    value: number | undefined,
    ceiling: number,
  ): number | undefined =>
    typeof value === 'number' && value > 0
      ? Math.min(Math.floor(value), ceiling)
      : undefined
  return {
    ...opts,
    maxChars: clamp(opts.maxChars, DEFAULT_MAX_CHARS),
    maxNodes: clamp(opts.maxNodes, DEFAULT_MAX_NODES),
    depth: clamp(opts.depth, MAX_SNAPSHOT_DEPTH),
  }
}

export async function snapshot(
  backend: BrowserBackend,
  targetId: string,
  opts: SnapshotOpts = {},
): Promise<SnapshotResult> {
  const bounded = clampSnapshotOpts(opts)
  return withReadBoost(backend, targetId, () =>
    snapshotInner(backend, targetId, bounded),
  )
}

async function snapshotInner(
  backend: BrowserBackend,
  targetId: string,
  opts: SnapshotOpts = {},
): Promise<SnapshotResult> {
  const page = await getPageForTarget(backend, targetId)
  const finish = (result: SnapshotResult): SnapshotResult => {
    recordSnapshotHealth(targetId, result.text)
    return result
  }
  const pack = async (raw: string, prefix = ''): Promise<SnapshotResult> => {
    const grouped = groupBadgeLabels(dropRedundantWrapperNames(raw))
    const scoped = opts.interactive ? keepInteractive(grouped) : grouped
    // Default: complete YAML. Char/node clip is only mode=efficient.
    const efficient = opts.mode === 'efficient'
    const { text, truncated } = efficient
      ? prioritizeAriaSnapshot(scoped, {
          maxChars: opts.maxChars ?? EFFICIENT_MAX_CHARS,
          maxNodes: opts.maxNodes ?? POST_ACTION_MAX_NODES,
        })
      : { text: scoped, truncated: false }
    let body = prefix + text
    if (opts.urls) {
      body = appendSnapshotUrls(body, await collectSnapshotUrls(page))
    }
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: body,
      nodes: countRefs(text),
      truncated,
    }
  }
  const packDialog = async (dialog: string): Promise<SnapshotResult> => {
    if (dialog.startsWith('A modal is open')) {
      return {
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: dialog,
        nodes: 1,
        truncated: true,
      }
    }
    return pack(dialog, DIALOG_PREFIX)
  }
  const emptyDialogPack = async (): Promise<SnapshotResult> => ({
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: 'No blocking in-page dialog is open.',
    nodes: 0,
    truncated: false,
  })
  try {
    if (opts.dialogOnly) {
      const dialog = await snapshotBlockingDialog(page)
      if (dialog) return finish(await packDialog(dialog))
      return finish(await emptyDialogPack())
    }
    // Default maxDepth is 30. Depth 6 on compact trees dropped nested
    // ExtJS comboboxes (and open dialogs became Close + title) without setting
    // truncated. Selector-scoped still uses the same default unless overridden.
    const depth = opts.depth ?? DEFAULT_SNAPSHOT_DEPTH
    if (opts.selector && isAriaRefCssSelector(opts.selector)) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: ariaRefCssSelectorMessage(opts.selector),
        nodes: 0,
        truncated: false,
      })
    }
    const skipIframeWalk = isSnapshotDegraded(targetId)
    let raw = ''
    let omittedFrames = skipIframeWalk
    if (opts.selector) {
      const selector = opts.selector
      raw = await withParkedOffscreenHidden(page, () =>
        scopedLocatorSnapshot(page, selector, SNAPSHOT_TIMEOUT_MS),
      )
    } else if (!skipIframeWalk) {
      // Detach PDF/receipt iframes first. Playwright AI mode still enter-frames
      // display:none iframes; we never snapshot iframe contents.
      raw = await raceMs(
        SNAPSHOT_TIMEOUT_MS + 500,
        withHeavyMediaHidden(page, () =>
          withParkedOffscreenHidden(page, () =>
            ariaSnapshotPage(page, SNAPSHOT_TIMEOUT_MS, depth),
          ),
        ),
        '',
      )
    }
    if (!raw && !opts.selector) {
      omittedFrames = true
      raw = await raceMs(
        EMBEDDED_FRAME_OMIT_MS,
        withEmbeddedFramesOmitted(page, () =>
          withParkedOffscreenHidden(page, () =>
            ariaSnapshotPage(page, EMBEDDED_FRAME_OMIT_MS, depth),
          ),
        ),
        '',
      )
    }
    // OpenClaw: miss → empty result, no full-page fallback. Refs are for act only.
    if (opts.selector && !raw) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: `No nodes matched selector ${JSON.stringify(opts.selector)}. That is not a PDF skip — use the last full snapshot, or omit selector.`,
        nodes: 0,
        truncated: false,
      })
    }
    if (!raw) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: `Full-page snapshot timed out. ${SNAPSHOT_STALL_NEXT}`,
        nodes: 1,
        truncated: true,
      })
    }
    return finish(await pack(raw, omittedFrames ? FRAMES_OMITTED_PREFIX : ''))
  } catch {
    const dialog = await snapshotBlockingDialog(page)
    if (dialog) return finish(await packDialog(dialog))
    if (opts.selector) {
      return finish({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: `Snapshot of ${JSON.stringify(opts.selector)} failed. Do not treat this as a PDF skip — omit selector or click the last refs.`,
        nodes: 0,
        truncated: false,
      })
    }
    return finish({
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: `Full-page snapshot timed out. ${SNAPSHOT_STALL_NEXT}`,
      nodes: 1,
      truncated: true,
    })
  }
}

export async function waitFor(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    time?: number
    text?: string
    textGone?: string
    selector?: string
    url?: string
    timeoutMs?: number
  },
): Promise<void> {
  const conditions = [
    opts.time != null,
    Boolean(opts.text),
    Boolean(opts.textGone),
    Boolean(opts.selector),
    Boolean(opts.url),
  ].filter(Boolean).length
  if (conditions === 0) {
    throw new BrowserError(
      'Either time, text, textGone, selector or url must be provided.\n' +
        'Recovery action: retry browser_wait_for with at least one wait condition',
    )
  }
  if (conditions > 1) {
    throw new BrowserError(
      'Provide exactly one of time, text, textGone, selector or url. ' +
        'Use timeoutMs to bound text, selector, or URL waits.\n' +
        'Recovery action: retry browser_wait_for with one wait condition',
    )
  }
  if (opts.time != null && opts.timeoutMs != null) {
    throw new BrowserError(
      'timeoutMs does not apply to a time-only delay. Omit timeoutMs.\n' +
        'Recovery action: retry browser_wait_for with time only',
    )
  }
  const timeoutMs =
    opts.timeoutMs == null || !Number.isFinite(opts.timeoutMs)
      ? WAIT_FOR_TIMEOUT_MS
      : Math.min(30_000, Math.max(100, opts.timeoutMs))
  const page = await getPageForTarget(backend, targetId)
  try {
    if (opts.time != null) {
      const ms = Math.min(WAIT_FOR_TIME_CAP_S, Math.max(0, opts.time)) * 1000
      await new Promise<void>(r => setTimeout(r, ms))
    }
    if (opts.textGone) {
      await page
        .getByText(opts.textGone)
        .first()
        .waitFor({ state: 'hidden', timeout: timeoutMs })
    }
    if (opts.text) {
      await page
        .getByText(opts.text)
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs })
    }
    if (opts.selector) {
      await page
        .locator(opts.selector)
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs })
    }
    if (opts.url) {
      await page.waitForURL(opts.url, { timeout: timeoutMs })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const what = opts.text
      ? `text ${JSON.stringify(opts.text)} to appear`
      : opts.textGone
        ? `text ${JSON.stringify(opts.textGone)} to disappear`
        : opts.selector
          ? `selector ${JSON.stringify(opts.selector)}`
          : opts.url
            ? `url ${JSON.stringify(opts.url)}`
            : 'condition'
    throw new BrowserError(
      /Timeout/i.test(message) ? `Timed out waiting for ${what}.` : message,
    )
  }
}

export async function findInSnapshot(
  backend: BrowserBackend,
  targetId: string,
  query: string,
): Promise<{ text: string; fromCache: boolean }> {
  const q = (query || '').trim()
  if (!q) throw new BrowserError('find requires a query string')
  let fromCache = true
  let yaml = getLastSnapshot(targetId)
  if (!yaml) {
    fromCache = false
    yaml = (await snapshot(backend, targetId, { interactive: true })).text
  }
  const hits = filterSnapshotLines(yaml, q)
  if (!hits) {
    return {
      text: `No snapshot lines matched ${JSON.stringify(q)}.`,
      fromCache,
    }
  }
  return { text: hits, fromCache }
}

/** Refresh the cached snapshot when it is older than SNAPSHOT_TTL_MS. */
export async function ensureSnapshotFresh(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  if (!isSnapshotStale(targetId)) return
  await forceRefreshSnapshot(backend, targetId)
}

/** Always recapture so stale-ref recovery can rematch against live refs. */
export async function forceRefreshSnapshot(
  backend: BrowserBackend,
  targetId: string,
): Promise<void> {
  await snapshot(backend, targetId, {
    maxNodes: POST_ACTION_MAX_NODES,
  })
}
