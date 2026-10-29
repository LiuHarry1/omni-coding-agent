/**
 * The `browser_*` tool family.
 *
 * Every tool goes through `defineBrowserTool`, which resolves the active tab,
 * bounds the call, funnels failures into recoverable tool text, and returns the
 * same observation shape. Nothing here knows which backend it is driving — it
 * only ever sees `BrowserBackend` — which is what lets the same tools point at
 * the user's own Chrome once the extension relay lands.
 */

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { tool } from 'ai'
import { z } from 'zod'
import * as inspect from '../../browser/page-inspect.js'
import { sendCdpCommand } from '../../browser/cdp-command.js'
import * as pw from '../../browser/playwright/index.js'
import {
  CALL_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_NODES,
  DEFAULT_SNAPSHOT_DEPTH,
  EFFICIENT_MAX_CHARS,
  MAX_SNAPSHOT_DEPTH,
  POST_ACTION_MAX_NODES,
  POST_ACTION_SNAPSHOT_MS,
} from '../../browser/limits.js'
import { SNAPSHOT_STALL_NEXT } from '../../browser/heavy-media.js'
import {
  clearCurrentTab,
  getBrowser,
  getCurrentTabId,
  openTab,
  recordHandoff,
  resolveTab,
  setCurrentTab,
} from '../../browser/manager.js'
import { BrowserError, type BrowserBackend } from '../../browser/types.js'
import { getExtensionRelay } from '../../browser/backends/extension.js'
import {
  clearViewportScreenshot,
  rememberViewportScreenshot,
} from '../../browser/viewport-screenshot-cache.js'
import { formatScrollOutcome } from '../../browser/scroll-report.js'
import { DEFAULT_DOWNLOAD_DIR } from '../../browser/paths.js'
import {
  clearTabMemory,
  getUserHasControl,
  isSnapshotDegraded,
  isTabPoisoned,
  setSnapshotDegraded,
  setUserHasControl,
} from '../../browser/session-flags.js'
import {
  assertBrowserAgentMayAct,
  isBrowserToolBlockedByUserControl,
  trackActiveBrowserTool,
  untrackActiveBrowserTool,
} from '../../browser/active-browser-tools.js'
import {
  BROWSER_CDP_TOOL_NAME,
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_FILE_UPLOAD_TOOL_NAME,
  BROWSER_FILL_FORM_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  BROWSER_GET_TEXT_TOOL_NAME,
  BROWSER_HANDLE_DIALOG_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_HOVER_TOOL_NAME,
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_MOUSE_CLICK_XY_TOOL_NAME,
  BROWSER_DRAG_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_PRESS_KEY_TOOL_NAME,
  BROWSER_RESIZE_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SELECT_OPTION_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
  BROWSER_WAIT_FOR_DOWNLOAD_TOOL_NAME,
} from '../../constants/tool_names.js'
import type {
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import { readImageDimensions } from '../../utils/image/dimensions.js'
import * as prompt from './prompt.js'
import {
  attachScreenshot,
  browserErrorText,
  BrowserOutputSchema,
  mapBrowserOutput,
  maybePersistSnapshotArtifact,
  observe,
  resetConsoleWatermark,
  toNetworkRow,
  type BrowserToolOutput,
} from './shared.js'

interface RunContext {
  backend: BrowserBackend
  targetId: string
  cwd: string
  sessionId?: string
  toolCallId: string
  abortSignal?: AbortSignal
}

async function observeAfterAction(
  backend: BrowserBackend,
  targetId: string,
  opts: Parameters<typeof observe>[2] & { screenshotAfterwards?: boolean },
  ctx?: Pick<RunContext, 'sessionId' | 'toolCallId'>,
): Promise<BrowserToolOutput> {
  // Sticky degrade after PDF/iframe stall used to skip every post-action
  // snapshot, so the model never got new refs and looped on screenshot.
  // Form mutations clear the flag and re-attempt with a short budget.
  const recovering = isSnapshotDegraded(targetId) && opts.withSnapshot !== false
  if (recovering) setSnapshotDegraded(targetId, false)
  const skipIfDegraded = opts.skipIfDegraded !== false
  const snapshotMs =
    opts.withSnapshot === false
      ? 5_000
      : recovering
        ? 5_000
        : POST_ACTION_SNAPSHOT_MS
  try {
    const out = await withTimeout(
      observe(backend, targetId, {
        ...opts,
        skipIfDegraded,
        // Post-action is a full tree (spill to disk if huge), not an 8k clip.
        mode: opts.mode ?? 'full',
        sessionId: ctx?.sessionId ?? opts.sessionId,
        toolCallId: ctx?.toolCallId ?? opts.toolCallId,
      }),
      'snapshot',
      snapshotMs,
    )
    if (opts.screenshotAfterwards && ctx) {
      try {
        const shot = await pw.screenshot(backend, targetId, { format: 'jpeg' })
        await attachScreenshot(out, shot, ctx.sessionId, ctx.toolCallId)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        out.message = `${out.message} (screenshot afterwards failed: ${reason})`
      }
    }
    return out
  } catch {
    try {
      const snap = await withTimeout(
        pw.snapshot(backend, targetId, { dialogOnly: true, maxNodes: 60 }),
        'dialog-snapshot',
        5_000,
      )
      if (
        snap.nodes > 0 ||
        (snap.text && !/^No blocking in-page dialog/.test(snap.text))
      ) {
        const dialogOut: BrowserToolOutput = {
          action: opts.action,
          message: `${opts.message} (full snapshot timed out; showing the open dialog — click it, do not wait or navigate)`,
          url: snap.url,
          title: snap.title,
          snapshot: snap.text,
          snapshotTruncated: snap.truncated,
          snapshotMode: 'efficient',
        }
        if (ctx) {
          await maybePersistSnapshotArtifact(
            dialogOut,
            ctx.sessionId,
            ctx.toolCallId,
          )
        }
        return dialogOut
      }
    } catch {
      /* dialog-only look failed too */
    }
    return {
      action: opts.action,
      message: `${opts.message} (snapshot timed out. ${SNAPSHOT_STALL_NEXT})`,
      url: '',
      title: '',
      snapshot: SNAPSHOT_STALL_NEXT,
      snapshotMode: 'efficient',
    }
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  action: string,
  ms: number = CALL_TIMEOUT_MS,
  signal?: AbortSignal,
  onTimeout?: (error: BrowserError) => void,
): Promise<T> {
  const interruptionError = () => {
    const reason = signal?.reason
    return reason instanceof Error
      ? reason
      : new BrowserError(`${action} interrupted by user`)
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(interruptionError())
      return
    }
    const timer = setTimeout(() => {
      const error = new BrowserError(
        `${action} timed out after ${ms / 1000}s. The page may be stuck loading; check the dev server or try browser_console.`,
      )
      reject(error)
      onTimeout?.(error)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(interruptionError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function withRelayLifecycle<T>(
  backend: BrowserBackend,
  currentTargetId: () => string,
  run: () => Promise<T>,
  interrupt: (reason: BrowserError) => void,
): Promise<T> {
  const relay = getExtensionRelay(backend)
  if (!relay) return run()

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let unsubscribeDisconnect = () => {}
    let unsubscribeTargetGone = () => {}
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      unsubscribeDisconnect()
      unsubscribeTargetGone()
      fn()
    }
    const disconnected = (reason: string) => {
      const error = new BrowserError(reason)
      finish(() => {
        reject(error)
        interrupt(error)
      })
    }
    unsubscribeDisconnect = relay.onDisconnect(disconnected)
    unsubscribeTargetGone = relay.onTargetGone(event => {
      const targetId = currentTargetId()
      if (!targetId || event.targetId !== targetId) return
      const action =
        event.reason === 'revoked' ? 'was unshared by the user' : 'was closed'
      const error = new BrowserError(
        `The current browser tab (${targetId}) ${action}. The in-flight browser operation was cancelled.\n` +
          'Recovery action: browser_navigate to open a fresh tab, or browser_tabs with action "list"',
      )
      finish(() => {
        reject(error)
        interrupt(error)
      })
    })
    if (!relay.isConnected()) {
      disconnected(
        'The browser extension disconnected. Reopen Chrome or re-enable the extension, then try again.',
      )
      return
    }
    run().then(
      value => finish(() => resolve(value)),
      err => finish(() => reject(err)),
    )
  })
}

const screenshotAfterwardsSchema = z
  .boolean()
  .optional()
  .describe('When true, capture a screenshot after the action completes')

function assertAgentMayAct(
  toolName: string,
  args: unknown,
  sessionId?: string,
): void {
  if (!getUserHasControl(sessionId)) return
  assertBrowserAgentMayAct(toolName, args)
}

function defineBrowserTool<S extends z.ZodTypeAny>(cfg: {
  name: string
  summary: string
  description: string
  inputSchema: S
  /** False for tab list/select, which must work before a current tab exists. */
  requireTab?: boolean
  run: (args: z.infer<S>, ctx: RunContext) => Promise<BrowserToolOutput>
}): ToolDefinition {
  return {
    name: cfg.name,
    description: cfg.summary,
    shouldDefer: true,
    outputSchema: BrowserOutputSchema,
    mapToolResultToToolResultBlockParam: mapBrowserOutput,
    create(cwd: string, context: ToolContext) {
      return tool({
        description: cfg.description,
        inputSchema: cfg.inputSchema,
        execute: async (
          args: z.infer<S>,
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ): Promise<DualChannelToolResult<BrowserToolOutput> | string> => {
          const toolCallId = options?.toolCallId ?? randomUUID()
          const abortSignal = options?.abortSignal
          const timeoutController = new AbortController()
          const forwardAbort = () => {
            const reason = abortSignal?.reason
            timeoutController.abort(
              reason instanceof Error && reason.name !== 'AbortError'
                ? reason
                : new BrowserError(`${cfg.name} interrupted by user`),
            )
          }
          if (abortSignal?.aborted) forwardAbort()
          else
            abortSignal?.addEventListener('abort', forwardAbort, {
              once: true,
            })
          const executionSignal = timeoutController.signal
          const abortOnTimeout = (error: BrowserError) =>
            timeoutController.abort(error)
          const sessionId = context.sessionId
          trackActiveBrowserTool(sessionId, toolCallId, cfg.name, args)
          try {
            if (executionSignal.aborted) {
              return browserErrorText(
                getUserHasControl(sessionId)
                  ? new BrowserError(
                      `${cfg.name} interrupted because the user took control of the browser.\n` +
                        'Recovery action: stop and wait for the user to say they are done, then browser_lock with action "lock"',
                    )
                  : new BrowserError('interrupted by user'),
                cfg.name,
              )
            }
            let resolved:
              { backend: BrowserBackend; targetId: string } | undefined
            try {
              const cwdNow = context.cwd ?? cwd
              if (cfg.requireTab === false) {
                const backend = await withTimeout(
                  getBrowser(cwdNow, sessionId),
                  cfg.name,
                  CALL_TIMEOUT_MS,
                  executionSignal,
                  abortOnTimeout,
                )
                resolved = {
                  backend,
                  targetId: getCurrentTabId(sessionId) ?? '',
                }
              } else {
                resolved = await withTimeout(
                  resolveTab(cwdNow, undefined, sessionId),
                  cfg.name,
                  CALL_TIMEOUT_MS,
                  executionSignal,
                  abortOnTimeout,
                )
              }
              const active = resolved
              assertAgentMayAct(cfg.name, args, sessionId)
              if (cfg.name !== BROWSER_MOUSE_CLICK_XY_TOOL_NAME) {
                clearViewportScreenshot(active.backend, active.targetId)
              }
              const mustSettleBeforeInterrupt =
                isBrowserToolBlockedByUserControl(cfg.name, args)
              const operation = withRelayLifecycle(
                active.backend,
                () =>
                  cfg.name === BROWSER_TABS_TOOL_NAME
                    ? ''
                    : (getCurrentTabId(sessionId) ?? active.targetId),
                () =>
                  cfg.run(args, {
                    backend: active.backend,
                    targetId: active.targetId,
                    cwd: cwdNow,
                    sessionId,
                    toolCallId,
                    abortSignal: executionSignal,
                  }),
                error => timeoutController.abort(error),
              )
              const data = await withTimeout(
                mustSettleBeforeInterrupt
                  ? operation.then(value => {
                      if (executionSignal.aborted) {
                        const reason = executionSignal.reason
                        throw reason instanceof Error
                          ? reason
                          : new BrowserError(`${cfg.name} interrupted by user`)
                      }
                      return value
                    })
                  : operation,
                cfg.name,
                CALL_TIMEOUT_MS,
                mustSettleBeforeInterrupt ? undefined : executionSignal,
                abortOnTimeout,
              )
              if (data.url || data.title) {
                recordHandoff(sessionId, {
                  targetId:
                    (getCurrentTabId(sessionId) ?? active.targetId) ||
                    undefined,
                  url: data.url,
                  title: data.title,
                })
              }
              return { data }
            } catch (err) {
              if (abortSignal?.aborted && getUserHasControl(sessionId)) {
                return browserErrorText(
                  new BrowserError(
                    `${cfg.name} interrupted because the user took control of the browser.\n` +
                      'Recovery action: stop and wait for the user to say they are done, then browser_lock with action "lock"',
                  ),
                  cfg.name,
                )
              }
              return browserErrorText(err, cfg.name)
            }
          } finally {
            abortSignal?.removeEventListener('abort', forwardAbort)
            untrackActiveBrowserTool(sessionId, toolCallId)
          }
        },
      })
    },
  }
}

const refSchema = z
  .string()
  .describe('Element ref from the latest snapshot, e.g. "e12"')

export const navigateTool = defineBrowserTool({
  name: BROWSER_NAVIGATE_TOOL_NAME,
  summary: 'Navigate to a URL',
  description: prompt.NAVIGATE_DESCRIPTION,
  requireTab: false,
  inputSchema: z.object({
    url: z
      .string()
      .describe('The URL to navigate to (http(s) only)'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run({ url, screenshotAfterwards }, ctx) {
    let targetId = ctx.targetId
    if (targetId && isTabPoisoned(targetId)) {
      const poisonedTargetId = targetId
      const tab = await openTab(ctx.cwd, undefined, ctx.sessionId)
      targetId = tab.targetId
      await ctx.backend.closeTab(poisonedTargetId).catch(() => {})
      clearTabMemory(poisonedTargetId)
      resetConsoleWatermark(poisonedTargetId)
      clearViewportScreenshot(ctx.backend, poisonedTargetId)
    }
    // The remembered tab may have been closed or revoked from the extension
    // popup since the last call; navigate then opens a fresh one.
    if (
      targetId &&
      !(await ctx.backend.listTabs()).some(t => t.targetId === targetId)
    ) {
      targetId = ''
    }
    if (!targetId) {
      const tab = await openTab(ctx.cwd, undefined, ctx.sessionId)
      targetId = tab.targetId
    }
    resetConsoleWatermark(targetId)
    try {
      await pw.navigate(ctx.backend, targetId, { url }, ctx.abortSignal)
    } catch (err) {
      if (!ctx.abortSignal?.aborted && targetId && isTabPoisoned(targetId)) {
        const failedTargetId = targetId
        const replacement = await openTab(ctx.cwd, undefined, ctx.sessionId)
        await ctx.backend.closeTab(failedTargetId).catch(() => {})
        clearTabMemory(failedTargetId)
        resetConsoleWatermark(failedTargetId)
        clearViewportScreenshot(ctx.backend, failedTargetId)
        const reason = err instanceof Error ? err.message : String(err)
        const summary = reason.split('\nRecovery action:')[0]
        throw new BrowserError(
          `${summary}\n` +
            `A fresh blank tab (${replacement.targetId}) replaced unusable tab ${failedTargetId} as the current target.\n` +
            'Recovery action: retry browser_navigate to the requested URL',
        )
      }
      throw err
    }
    return observeAfterAction(
      ctx.backend,
      targetId,
      {
        action: 'navigate',
        message: `Navigated to ${url}`,
        mode: 'full',
        skipIfDegraded: false,
        screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const snapshotTool = defineBrowserTool({
  name: BROWSER_SNAPSHOT_TOOL_NAME,
  summary: 'Capture an accessibility snapshot of the current page',
  description: prompt.SNAPSHOT_DESCRIPTION,
  inputSchema: z.object({
    mode: z
      .enum(['efficient', 'full'])
      .optional()
      .describe(
        `full (default): complete tree. efficient: budgeted clip (~${EFFICIENT_MAX_CHARS} chars).`,
      ),
    maxDepth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Maximum snapshot tree depth. Defaults to ${DEFAULT_SNAPSHOT_DEPTH}, capped at ${MAX_SNAPSHOT_DEPTH}.`,
      ),
    maxNodes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Ref-bearing node cap for mode=efficient (default ${POST_ACTION_MAX_NODES}, max ${DEFAULT_MAX_NODES}).`,
      ),
    maxChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Character budget for mode=efficient only (max ${DEFAULT_MAX_CHARS}).`,
      ),
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector for one subtree (e.g. [role=dialog]). Not a snapshot ref — [ref=eN] is rejected.',
      ),
    interactive: z
      .boolean()
      .optional()
      .describe(
        'When true, only include interactive elements. Defaults to false.',
      ),
    includeDiff: z
      .boolean()
      .optional()
      .describe('Return only added/removed lines since the last snapshot'),
    urls: z.boolean().optional().describe('Append discovered link hrefs'),
  }),
  async run(
    {
      mode,
      maxDepth,
      maxNodes,
      maxChars,
      selector,
      interactive,
      includeDiff,
      urls,
    },
    ctx,
  ) {
    const resolvedMode = mode ?? 'full'
    return observe(ctx.backend, ctx.targetId, {
      action: 'snapshot',
      message: includeDiff
        ? `Page snapshot (diff, ${resolvedMode})`
        : `Page snapshot (${resolvedMode})`,
      mode: resolvedMode,
      depth: maxDepth,
      maxNodes:
        maxNodes ??
        (resolvedMode === 'efficient' ? POST_ACTION_MAX_NODES : undefined),
      maxChars:
        maxChars ??
        (resolvedMode === 'efficient' ? EFFICIENT_MAX_CHARS : undefined),
      selector,
      interactive: interactive ?? false,
      includeDiff,
      urls,
      skipIfDegraded: false,
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
    })
  },
})

export const getTextTool = defineBrowserTool({
  name: BROWSER_GET_TEXT_TOOL_NAME,
  summary: 'Read bounded visible page text (article/main/body or a selector)',
  description: prompt.GET_TEXT_DESCRIPTION,
  inputSchema: z.object({
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector for the prose region; defaults to first of article, main, body',
      ),
    maxChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Character budget for returned text (default/ceiling ${DEFAULT_MAX_CHARS})`,
      ),
  }),
  async run({ selector, maxChars }, ctx) {
    const got = await pw.getPageText(ctx.backend, ctx.targetId, {
      selector,
      maxChars,
    })
    const out: BrowserToolOutput = {
      action: 'get_text',
      message: got.truncated
        ? `Page text truncated at ${got.text.length} chars (selector ${got.selectorUsed}). Narrow the selector or raise maxChars.`
        : `Page text via ${got.selectorUsed}`,
      url: got.url,
      title: got.title,
      snapshot: got.text,
      snapshotTruncated: got.truncated,
      snapshotMode: 'text',
      pageState: {
        truncated: got.truncated,
        chars: got.text.length,
        mode: 'text',
      },
    }
    await maybePersistSnapshotArtifact(out, ctx.sessionId, ctx.toolCallId)
    return out
  },
})

export const clickTool = defineBrowserTool({
  name: BROWSER_CLICK_TOOL_NAME,
  summary: 'Click an element by ref',
  description: prompt.CLICK_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema.describe(
      'Exact target element reference from the page snapshot',
    ),
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
    doubleClick: z.boolean().optional().describe('Send a double click'),
    button: z
      .enum(['left', 'right', 'middle'])
      .optional()
      .describe('Mouse button (default left)'),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .optional()
      .describe('Modifier keys held during the click'),
    offsetX: z
      .number()
      .optional()
      .describe('Click offset from the element left edge (pixels)'),
    offsetY: z
      .number()
      .optional()
      .describe('Click offset from the element top edge (pixels)'),
    screenshotAfterwards: screenshotAfterwardsSchema,
    force: z.boolean().optional().describe('Skip actionability checks'),
  }),
  async run(args, ctx) {
    const el = await pw.click(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
      doubleClick: args.doubleClick,
      button: args.button,
      modifiers: args.modifiers,
      force: args.force,
      signal: ctx.abortSignal,
      offsetX: args.offsetX,
      offsetY: args.offsetY,
    })
    const label = args.element ? ` (${args.element})` : ''
    const recovered =
      args.ref && el.ref && el.ref !== args.ref
        ? ` (ref recovered: ${args.ref} → ${el.ref})`
        : ''
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'click',
        message: `${args.doubleClick ? 'Double-clicked' : 'Clicked'} ${el.role} "${el.name}"${label}${recovered}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const mouseClickXYTool = defineBrowserTool({
  name: BROWSER_MOUSE_CLICK_XY_TOOL_NAME,
  summary: 'Click viewport coordinates',
  description: prompt.MOUSE_CLICK_XY_DESCRIPTION,
  inputSchema: z.object({
    x: z
      .number()
      .finite()
      .describe('X coordinate from the latest viewport browser_screenshot'),
    y: z
      .number()
      .finite()
      .describe('Y coordinate from the latest viewport browser_screenshot'),
    doubleClick: z.boolean().optional().describe('Send a double click'),
    button: z
      .enum(['left', 'right', 'middle'])
      .optional()
      .describe('Mouse button (default left)'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const el = await pw.mouseClickXY(ctx.backend, ctx.targetId, {
      x: args.x,
      y: args.y,
      doubleClick: args.doubleClick,
      button: args.button,
    })
    const mapped =
      el.viewportCoordinates.x === el.screenshotCoordinates.x &&
      el.viewportCoordinates.y === el.screenshotCoordinates.y
        ? ''
        : ` mapped to viewport (${el.viewportCoordinates.x}, ${el.viewportCoordinates.y})`
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'mouse_click_xy',
        message: `${args.doubleClick ? 'Double-clicked' : 'Clicked'} screenshot coordinate (${el.screenshotCoordinates.x}, ${el.screenshotCoordinates.y})${mapped} on ${el.preview}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const typeTool = defineBrowserTool({
  name: BROWSER_TYPE_TOOL_NAME,
  summary: 'Type text into a field by ref',
  description: prompt.TYPE_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    text: z.string().describe('Text to type'),
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
    submit: z.boolean().optional().describe('Press Enter after typing'),
    slowly: z
      .boolean()
      .optional()
      .describe(
        'When true, click then type character-by-character (75ms). Default replaces via fill.',
      ),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const el = await pw.typeText(ctx.backend, ctx.targetId, {
      ref: args.ref,
      text: args.text,
      element: args.element,
      submit: args.submit,
      slowly: args.slowly,
      signal: ctx.abortSignal,
    })
    // An action that returned is not an action that worked: report what the
    // field actually holds so a silently rejected type is visible.
    const valueNote = el.readOnly
      ? ' — nothing typed: the field is readonly. Some apps compute it from other fields, or unlock it from another control.'
      : el.disabled
        ? ' — nothing typed: the field is disabled.'
        : el.value == null
          ? ''
          : el.value !== ''
            ? ` (value: ${JSON.stringify(el.value)})`
            : ' (value still empty — the field did not accept the text)'
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'type',
        message: `Typed ${JSON.stringify(args.text)} into ${el.role} "${el.name}"${args.submit ? ' and pressed Enter' : ''}${valueNote}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const fillFormTool = defineBrowserTool({
  name: BROWSER_FILL_FORM_TOOL_NAME,
  summary: 'Fill multiple form fields in one call',
  description: prompt.FILL_FORM_DESCRIPTION,
  inputSchema: z.object({
    fields: z
      .array(
        z.object({
          ref: refSchema,
          value: z
            .string()
            .describe(
              'Text, option label, or "true"/"false" for a checkbox or radio',
            ),
          kind: z
            .enum(['textbox', 'checkbox', 'radio', 'combobox'])
            .optional()
            .describe('Control type (inferred from the element when omitted)'),
        }),
      )
      .min(1)
      .describe('Fields to fill, in the order they should be written'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const filled = await pw.fillForm(
      ctx.backend,
      ctx.targetId,
      args.fields,
      ctx.abortSignal,
    )
    const ok = filled.filter(f => f.status === 'filled').length
    // Per-field lines, because a batch that "succeeded" can still have dropped
    // half its values, and only the page knows which half.
    const lines = filled.map(f =>
      f.status === 'filled'
        ? `- ${f.ref} ${f.role} "${f.name}" = ${JSON.stringify(f.value ?? '')}`
        : `- ${f.ref} ${f.role} "${f.name}" ${f.status}: ${f.reason ?? 'unknown reason'}`,
    )
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'fill_form',
        message: `Filled ${ok}/${filled.length} fields\n${lines.join('\n')}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const selectOptionTool = defineBrowserTool({
  name: BROWSER_SELECT_OPTION_TOOL_NAME,
  summary: 'Select an option in a native <select>',
  description: prompt.SELECT_OPTION_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    values: z
      .union([z.array(z.string()).min(1), z.string().min(1)])
      .transform(v =>
        (Array.isArray(v) ? v : [v])
          .map(s => s.replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string()).min(1))
      .describe('Visible labels (or native option values) to select'),
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const res = await pw.selectOption(
      ctx.backend,
      ctx.targetId,
      args.ref,
      args.values,
      args.element,
    )
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'select_option',
        message: `Selected ${res.selected.map(s => `"${s}"`).join(', ')}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const fileUploadTool = defineBrowserTool({
  name: BROWSER_FILE_UPLOAD_TOOL_NAME,
  summary: 'Upload files through the page file chooser',
  description: prompt.FILE_UPLOAD_DESCRIPTION,
  inputSchema: z.object({
    paths: z
      .array(z.string())
      .describe(
        'File paths to upload (workspace-relative or absolute). Empty list cancels the chooser',
      ),
    ref: refSchema
      .optional()
      .describe(
        'Optional. Use only if the snapshot already shows an <input type=file>. A paperclip/button ref is ignored.',
      ),
  }),
  async run(args, ctx) {
    const paths = args.paths.map(p =>
      path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p),
    )
    const missing: string[] = []
    for (const [i, p] of paths.entries()) {
      const stat = await fs.promises.stat(p).catch(() => null)
      if (!stat?.isFile()) {
        const given = args.paths[i]
        missing.push(given === p ? p : `${given} (resolved to ${p})`)
      }
    }
    if (missing.length) {
      throw new BrowserError(
        `File${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')}. Relative paths resolve against the workspace ${ctx.cwd}. Nothing was uploaded.\nRecovery action: locate the file (e.g. with Glob) and retry browser_file_upload with its correct path`,
      )
    }
    const res = await pw.uploadFilesToPage(ctx.backend, ctx.targetId, {
      paths,
      ref: args.ref,
    })
    const n = res.files.length
    // Receipt/PDF previews often stall Playwright snapshot+screenshot after
    // upload. Confirm success from the action message; let the next form
    // mutation re-observe instead of blocking here.
    const out = await observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'file_upload',
      message: res.cancelled
        ? 'Cancelled the file chooser'
        : `Uploaded ${n} file${n === 1 ? '' : 's'}: ${res.files.map(f => path.basename(f)).join(', ')}`,
      compact: true,
      mode: 'efficient',
    })
    const previewLikely =
      /\biframe\b/.test(String(out.snapshot ?? '')) ||
      /snapshot timed out/.test(out.message)
    if (!res.cancelled && previewLikely) {
      out.message = `${out.message}. PDF/receipt preview iframes are omitted from this snapshot (iframe contents are not entered). Click Close / Save from these refs — do not screenshot or wait_for the preview.`
    }
    return out
  },
})

export const handleDialogTool = defineBrowserTool({
  name: BROWSER_HANDLE_DIALOG_TOOL_NAME,
  summary: 'Accept or dismiss a native alert/confirm/prompt',
  description: prompt.HANDLE_DIALOG_DESCRIPTION,
  inputSchema: z.object({
    accept: z
      .boolean()
      .describe('true to accept / OK, false to dismiss / Cancel'),
    promptText: z
      .string()
      .optional()
      .describe('Text to type into a prompt before accepting'),
  }),
  async run(args, ctx) {
    const res = await pw.handleNativeDialog(ctx.backend, ctx.targetId, {
      accept: args.accept,
      promptText: args.promptText,
    })
    const message = res.armed
      ? `Next native dialog will be ${res.accepted ? 'accepted' : 'dismissed'}`
      : `${res.accepted ? 'Accepted' : 'Dismissed'} ${res.type} ${JSON.stringify(res.message)}`
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'handle_dialog',
      message,
      compact: true,
    })
  },
})

export const pressKeyTool = defineBrowserTool({
  name: BROWSER_PRESS_KEY_TOOL_NAME,
  summary: 'Press a key on the focused element',
  description: prompt.PRESS_KEY_DESCRIPTION,
  inputSchema: z.object({
    key: z.string().describe('Key name, e.g. "Enter", "Escape", "a"'),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .optional()
      .describe('Modifier keys held down'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    await pw.pressKey(ctx.backend, ctx.targetId, args.key, args.modifiers)
    const combo = [...(args.modifiers ?? []), args.key].join('+')
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'press_key',
        message: `Pressed ${combo}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const waitForTool = defineBrowserTool({
  name: BROWSER_WAIT_FOR_TOOL_NAME,
  summary: 'Wait for text to appear or disappear, or for time to pass',
  description: prompt.WAIT_FOR_DESCRIPTION,
  inputSchema: z.object({
    time: z
      .number()
      .optional()
      .describe('Time to wait in seconds (capped at 30)'),
    text: z.string().optional().describe('Text to wait for to appear'),
    textGone: z.string().optional().describe('Text to wait for to disappear'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector to wait until visible'),
    url: z.string().optional().describe('URL glob to wait for'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30_000)
      .optional()
      .describe(
        'Timeout for text, textGone, selector, or url in milliseconds (default 20000, max 30000). Not used with time.',
      ),
  }),
  async run(args, ctx) {
    await pw.waitFor(ctx.backend, ctx.targetId, {
      time: args.time,
      text: args.text,
      textGone: args.textGone,
      selector: args.selector,
      url: args.url,
      timeoutMs: args.timeoutMs,
    })
    const parts: string[] = []
    if (args.time != null) parts.push(`waited ${args.time}s`)
    if (args.text) parts.push(`text ${JSON.stringify(args.text)} appeared`)
    if (args.textGone) {
      parts.push(`text ${JSON.stringify(args.textGone)} disappeared`)
    }
    if (args.selector)
      parts.push(`selector ${JSON.stringify(args.selector)} visible`)
    if (args.url) parts.push(`url ${JSON.stringify(args.url)}`)
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'wait_for',
      message: parts.length ? parts.join('; ') : 'Waited',
      compact: true,
    })
  },
})

export const hoverTool = defineBrowserTool({
  name: BROWSER_HOVER_TOOL_NAME,
  summary: 'Hover the mouse over an element by ref',
  description: prompt.HOVER_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const el = await pw.hover(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
    })
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'hover',
        message: `Hovered ${el.role} "${el.name}"`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const scrollTool = defineBrowserTool({
  name: BROWSER_SCROLL_TOOL_NAME,
  summary: 'Scroll the page or an element',
  description: prompt.SCROLL_DESCRIPTION,
  inputSchema: z.object({
    deltaY: z
      .number()
      .optional()
      .describe('Vertical scroll in pixels; positive scrolls down'),
    deltaX: z.number().optional().describe('Horizontal scroll in pixels'),
    ref: z
      .string()
      .optional()
      .describe(
        'With a delta or direction: scroll the nearest scrollable container of this element. Alone: bring it into view',
      ),
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
    scrollIntoView: z
      .boolean()
      .optional()
      .describe(
        'Bring the ref into view (default when ref is given without a delta)',
      ),
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .optional()
      .describe('Scroll direction'),
    amount: z
      .number()
      .optional()
      .describe('Pixels for direction (default 300)'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    const outcome = await pw.scroll(ctx.backend, ctx.targetId, {
      deltaX: args.deltaX,
      deltaY: args.deltaY,
      ref: args.ref,
      element: args.element,
      scrollIntoView: args.scrollIntoView,
      direction: args.direction,
      amount: args.amount,
    })
    // The accessibility tree does not change with scroll position, so a
    // post-scroll snapshot costs tokens without telling the model anything.
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'scroll',
        message: formatScrollOutcome(outcome),
        withSnapshot: false,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const screenshotTool = defineBrowserTool({
  name: BROWSER_SCREENSHOT_TOOL_NAME,
  summary: 'Screenshot the page or a single element',
  description: prompt.SCREENSHOT_DESCRIPTION,
  inputSchema: z.object({
    ref: z
      .string()
      .optional()
      .describe('Screenshot just this element instead of the viewport'),
    fullPage: z
      .boolean()
      .optional()
      .describe('Capture the entire scrollable page, not just the viewport'),
    format: z
      .enum(['png', 'jpeg'])
      .optional()
      .describe('Image format (default png)'),
    labels: z
      .boolean()
      .optional()
      .describe(
        'Overlay snapshot refs on the screenshot and return their boxes',
      ),
  }),
  async run(args, ctx) {
    const format = args.format ?? 'png'
    const shot = args.labels
      ? await pw.screenshotWithLabels(ctx.backend, ctx.targetId, {
          ref: args.ref,
          fullPage: args.fullPage,
          type: format,
        })
      : await pw.screenshot(ctx.backend, ctx.targetId, {
          ref: args.ref,
          fullPage: args.fullPage,
          format,
        })
    const scope = args.ref
      ? `element ${args.ref}`
      : args.fullPage
        ? 'full page'
        : 'viewport'
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'screenshot',
      message:
        'labels' in shot
          ? `Screenshot of ${scope} with ${shot.labels} labels (${shot.skipped} skipped)`
          : `Screenshot of ${scope}`,
      withSnapshot: false,
    })
    if (args.labels && 'annotations' in shot) {
      out.annotations = shot.annotations
    }
    await attachScreenshot(
      out,
      { buffer: shot.buffer, format },
      ctx.sessionId,
      ctx.toolCallId,
    )
    if (
      !args.labels &&
      !args.ref &&
      !args.fullPage &&
      'viewport' in shot &&
      out.screenshotBase64
    ) {
      const dimensions = readImageDimensions(
        Buffer.from(out.screenshotBase64, 'base64'),
      )
      if (dimensions) {
        rememberViewportScreenshot(ctx.backend, ctx.targetId, {
          url: shot.url,
          viewportCssWidth: shot.viewport.width,
          viewportCssHeight: shot.viewport.height,
          sentImageWidth: dimensions.width,
          sentImageHeight: dimensions.height,
        })
      }
    }
    return out
  },
})

export const consoleTool = defineBrowserTool({
  name: BROWSER_CONSOLE_TOOL_NAME,
  summary: 'Read console output and uncaught errors from the page',
  description: prompt.CONSOLE_DESCRIPTION,
  inputSchema: z.object({
    level: z
      .enum(['log', 'info', 'warn', 'error', 'debug'])
      .optional()
      .describe('Only return this level'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max entries to return (default 100)'),
  }),
  async run(args, ctx) {
    const logs = await inspect.consoleLogs(ctx.backend, ctx.targetId, {
      level: args.level,
      limit: args.limit,
    })
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'console',
      message: logs.entries.length
        ? `${logs.entries.length} console ${args.level ?? 'message'}${logs.entries.length === 1 ? '' : 's'}`
        : 'No console output',
      withSnapshot: false,
    })
    // Full listing at the requested level, not just errors from this call.
    out.consoleErrors = logs.entries.map(e => ({
      level: e.level,
      text: e.text,
    }))
    return out
  },
})

export const networkTool = defineBrowserTool({
  name: BROWSER_NETWORK_TOOL_NAME,
  summary: 'List fetch/XHR requests the page made, with status and timing',
  description: prompt.NETWORK_DESCRIPTION,
  inputSchema: z.object({
    failedOnly: z
      .boolean()
      .optional()
      .describe('Only requests that failed or returned status >= 400'),
    urlContains: z
      .string()
      .optional()
      .describe('Only requests whose URL contains this substring'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max entries to return (default 50)'),
  }),
  async run(args, ctx) {
    const net = await inspect.networkRequests(ctx.backend, ctx.targetId, {
      failedOnly: args.failedOnly,
      urlContains: args.urlContains,
      limit: args.limit,
    })
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'network',
      message: net.entries.length
        ? `${net.entries.length} request${net.entries.length === 1 ? '' : 's'}`
        : 'No matching requests',
      withSnapshot: false,
    })
    // Replace the automatic failures-only view with the requested listing.
    out.network = net.entries.map(toNetworkRow)
    out.networkTotal = net.total
    return out
  },
})

export const tabsTool = defineBrowserTool({
  name: BROWSER_TABS_TOOL_NAME,
  summary: 'List, select, open or close browser tabs',
  description: prompt.TABS_DESCRIPTION,
  requireTab: false,
  inputSchema: z.object({
    action: z.enum(['list', 'select', 'new', 'close']).describe('What to do'),
    tabId: z
      .string()
      .optional()
      .describe('Tab id from `list`; required for select and close'),
    url: z.string().optional().describe('URL to open with `new`'),
  }),
  async run(args, ctx) {
    let message: string

    switch (args.action) {
      case 'new': {
        // Create blank first so the page-inspection script is installed before
        // the destination's first console call or fetch/XHR can run.
        const previousTargetId = getCurrentTabId(ctx.sessionId)
        const tab = await openTab(ctx.cwd, undefined, ctx.sessionId)
        try {
          if (args.url) {
            await pw.navigate(
              ctx.backend,
              tab.targetId,
              { url: args.url },
              ctx.abortSignal,
            )
          }
        } catch (err) {
          // A tab created by this action has no useful prior state to preserve.
          // Do not strand an unidentified poisoned about:blank tab when its
          // initial navigation fails.
          await ctx.backend.closeTab(tab.targetId).catch(() => {})
          clearTabMemory(tab.targetId)
          resetConsoleWatermark(tab.targetId)
          clearViewportScreenshot(ctx.backend, tab.targetId)
          const remaining = await ctx.backend.listTabs().catch(() => [])
          if (
            previousTargetId &&
            remaining.some(candidate => candidate.targetId === previousTargetId)
          ) {
            setCurrentTab(previousTargetId, ctx.sessionId)
          } else if (getCurrentTabId(ctx.sessionId) === tab.targetId) {
            clearCurrentTab(ctx.sessionId)
          }
          throw err
        }
        message = args.url
          ? `Opened ${args.url} in a new tab`
          : 'Opened a new tab'
        setCurrentTab(tab.targetId, ctx.sessionId)
        break
      }
      case 'select': {
        if (!args.tabId) throw new BrowserError('select requires a tabId.')
        const tabs = await ctx.backend.listTabs()
        if (!tabs.some(t => t.targetId === args.tabId)) {
          throw new BrowserError(
            `No open tab with id "${args.tabId}". Run browser_tabs with action "list".`,
          )
        }
        setCurrentTab(args.tabId, ctx.sessionId)
        await pw.activateTab(ctx.backend, args.tabId)
        message = `Selected tab ${args.tabId}`
        break
      }
      case 'close': {
        if (!args.tabId) throw new BrowserError('close requires a tabId.')
        const before = await ctx.backend.listTabs()
        const closedAt = before.findIndex(t => t.targetId === args.tabId)
        if (closedAt < 0) {
          throw new BrowserError(
            `No open tab with id "${args.tabId}". Run browser_tabs with action "list".`,
          )
        }
        await ctx.backend.closeTab(args.tabId)
        // Refs and the console offset are keyed by target id, and Chrome reuses
        // those ids. Left behind, they would be read as the next tab's state.
        clearTabMemory(args.tabId)
        resetConsoleWatermark(args.tabId)
        // Closing the active tab would otherwise leave the session pointing at
        // a dead target, which resolveTab rejects. The agent closed it on
        // purpose, so adopt the neighbour Chrome itself would focus.
        if (getCurrentTabId(ctx.sessionId) === args.tabId) {
          const remaining = before.filter(t => t.targetId !== args.tabId)
          const next = remaining[Math.min(closedAt, remaining.length - 1)]
          if (next) setCurrentTab(next.targetId, ctx.sessionId)
          else clearCurrentTab(ctx.sessionId)
        }
        message = `Closed tab ${args.tabId}`
        break
      }
      default:
        message = 'Open tabs'
    }

    const tabs = await ctx.backend.listTabs()
    const current = getCurrentTabId(ctx.sessionId)
    const out: BrowserToolOutput = {
      action: 'tabs',
      message,
      url: tabs.find(t => t.targetId === current)?.url ?? '',
      title: tabs.find(t => t.targetId === current)?.title ?? '',
      tabs: tabs.map(t => ({ ...t, current: t.targetId === current })),
    }
    return out
  },
})

export const dragTool = defineBrowserTool({
  name: BROWSER_DRAG_TOOL_NAME,
  summary: 'Drag from one element to another',
  description: prompt.DRAG_DESCRIPTION,
  inputSchema: z.object({
    startRef: refSchema.describe('Element to drag'),
    endRef: refSchema.describe('Drop target'),
  }),
  async run(args, ctx) {
    await pw.drag(ctx.backend, ctx.targetId, {
      startRef: args.startRef,
      endRef: args.endRef,
    })
    return observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'drag',
      message: `Dragged ${args.startRef} to ${args.endRef}`,
      compact: true,
    })
  },
})

export const resizeTool = defineBrowserTool({
  name: BROWSER_RESIZE_TOOL_NAME,
  summary: 'Resize the browser viewport',
  description: prompt.RESIZE_DESCRIPTION,
  inputSchema: z.object({
    width: z.number().int().positive().describe('Viewport width in CSS pixels'),
    height: z
      .number()
      .int()
      .positive()
      .describe('Viewport height in CSS pixels'),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    await pw.resizeViewport(ctx.backend, ctx.targetId, args.width, args.height)
    return observeAfterAction(
      ctx.backend,
      ctx.targetId,
      {
        action: 'resize',
        message: `Resized viewport to ${args.width}x${args.height}`,
        compact: true,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
  },
})

export const waitForDownloadTool = defineBrowserTool({
  name: BROWSER_WAIT_FOR_DOWNLOAD_TOOL_NAME,
  summary: 'Wait for the next browser download and save it',
  description: prompt.WAIT_FOR_DOWNLOAD_DESCRIPTION,
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe('Optional file path relative to the agent downloads directory'),
    ref: z
      .string()
      .optional()
      .describe('If set, click this ref then wait for the download'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30_000)
      .optional()
      .describe('Download timeout in milliseconds (default 25000, max 30000)'),
  }),
  async run(args, ctx) {
    const dest = args.path
      ? path.resolve(DEFAULT_DOWNLOAD_DIR, args.path)
      : undefined
    if (dest && path.relative(DEFAULT_DOWNLOAD_DIR, dest).startsWith('..')) {
      throw new BrowserError(
        `Downloads can only be saved under ${DEFAULT_DOWNLOAD_DIR}; ${JSON.stringify(args.path)} is outside it.\nRecovery action: retry browser_wait_for_download with a relative path, or omit path`,
      )
    }
    const result = args.ref
      ? await pw.downloadByRef(ctx.backend, ctx.targetId, {
          ref: args.ref,
          path: dest,
          timeoutMs: args.timeoutMs,
          signal: ctx.abortSignal,
        })
      : await pw.waitForDownload(ctx.backend, ctx.targetId, {
          path: dest,
          timeoutMs: args.timeoutMs,
          signal: ctx.abortSignal,
        })
    const out = await observeAfterAction(ctx.backend, ctx.targetId, {
      action: 'wait_for_download',
      message: `Saved download ${JSON.stringify(result.suggestedFilename)}`,
      compact: true,
    })
    out.downloadPath = result.path
    return out
  },
})

export const highlightTool = defineBrowserTool({
  name: BROWSER_HIGHLIGHT_TOOL_NAME,
  summary: 'Highlight an element on the page for visual grounding',
  description: prompt.HIGHLIGHT_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
    durationMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Highlight duration in milliseconds (default 2000)'),
  }),
  async run(args, ctx) {
    const el = await pw.highlightElement(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
      durationMs: args.durationMs,
    })
    return observe(ctx.backend, ctx.targetId, {
      action: 'highlight',
      message: `Highlighted ${el.role} "${el.name}"`,
      compact: true,
    })
  },
})

export const getBoundingBoxTool = defineBrowserTool({
  name: BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  summary: 'Get the viewport bounding box for a snapshot ref',
  description: prompt.GET_BOUNDING_BOX_DESCRIPTION,
  inputSchema: z.object({
    ref: refSchema,
    element: z.string().optional().describe(prompt.ELEMENT_HINT_DESCRIPTION),
  }),
  async run(args, ctx) {
    const box = await pw.getElementBoundingBox(ctx.backend, ctx.targetId, {
      ref: args.ref,
      element: args.element,
    })
    const out = await observe(ctx.backend, ctx.targetId, {
      action: 'get_bounding_box',
      message: `Bounding box for ${args.ref}: x=${Math.round(box.x)}, y=${Math.round(box.y)}, width=${Math.round(box.width)}, height=${Math.round(box.height)}`,
      withSnapshot: false,
    })
    out.value = box
    return out
  },
})

export const cdpTool = defineBrowserTool({
  name: BROWSER_CDP_TOOL_NAME,
  summary: prompt.CDP_SUMMARY,
  description: prompt.CDP_DESCRIPTION,
  inputSchema: z.object({
    method: z
      .string()
      .describe(
        'CDP method name, for example Runtime.evaluate, Profiler.start, or Performance.getMetrics.',
      ),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'CDP params object. Omit or pass {} when the command takes no params.',
      ),
    viewId: z
      .string()
      .optional()
      .describe(
        'Target browser tab ID. If omitted, uses the last interacted tab.',
      ),
    screenshotAfterwards: screenshotAfterwardsSchema,
  }),
  async run(args, ctx) {
    let targetId = ctx.targetId
    if (args.viewId) {
      const resolved = await resolveTab(ctx.cwd, args.viewId, ctx.sessionId)
      targetId = resolved.targetId
    }
    const method = args.method.trim()
    const interruptCdp = () => {
      const cleanupMethod = /^Runtime\.(evaluate|callFunctionOn)$/.test(method)
        ? 'Runtime.terminateExecution'
        : method === 'Page.navigate'
          ? 'Page.stopLoading'
          : undefined
      if (cleanupMethod) {
        void ctx.backend.send(targetId, cleanupMethod).catch(() => {})
      }
    }
    if (ctx.abortSignal?.aborted) {
      const reason = ctx.abortSignal.reason
      throw reason instanceof Error
        ? reason
        : new BrowserError('browser_cdp interrupted by user')
    }
    ctx.abortSignal?.addEventListener('abort', interruptCdp, { once: true })
    let sent: Awaited<ReturnType<typeof sendCdpCommand>>
    try {
      sent = await sendCdpCommand(
        ctx.backend,
        targetId,
        method,
        args.params,
        ctx.sessionId,
      )
      if (ctx.abortSignal?.aborted) {
        const reason = ctx.abortSignal.reason
        throw reason instanceof Error
          ? reason
          : new BrowserError('browser_cdp interrupted by user')
      }
    } finally {
      ctx.abortSignal?.removeEventListener('abort', interruptCdp)
    }
    const message = sent.overflow
      ? `${sent.reason}\nFile: ${sent.filePath}`
      : `CDP ${args.method.trim()}`
    const out = await observeAfterAction(
      ctx.backend,
      targetId,
      {
        action: 'cdp',
        message,
        withSnapshot: false,
        screenshotAfterwards: args.screenshotAfterwards,
      },
      ctx,
    )
    out.value = sent.overflow
      ? { savedTo: sent.filePath, size: sent.sizeBytes }
      : sent.result
    return out
  },
})

export const lockTool = defineBrowserTool({
  name: BROWSER_LOCK_TOOL_NAME,
  summary: 'Take or release control of the browser',
  description: prompt.LOCK_DESCRIPTION,
  requireTab: false,
  inputSchema: z.object({
    action: z
      .enum(['lock', 'unlock'])
      .describe(
        'lock: agent resumes driving the page; unlock: user takes over',
      ),
  }),
  async run({ action }, ctx) {
    if (action === 'unlock') {
      setUserHasControl(true, ctx.sessionId)
      return {
        action: 'lock',
        message:
          'User has control. Do not click, type, navigate, or fill. Call browser_lock with action "lock" when they are done.',
        url: '',
        title: '',
      }
    }
    setUserHasControl(false, ctx.sessionId)
    const tabs = ctx.targetId
      ? await ctx.backend.listTabs().catch(() => [])
      : []
    const current = tabs.find(t => t.targetId === ctx.targetId)
    return {
      action: 'lock',
      message: 'Agent has control of the browser.',
      url: current?.url ?? '',
      title: current?.title ?? '',
    }
  },
})

export const browserToolDefinitions: ToolDefinition[] = [
  navigateTool,
  snapshotTool,
  getTextTool,
  clickTool,
  mouseClickXYTool,
  typeTool,
  fillFormTool,
  selectOptionTool,
  fileUploadTool,
  handleDialogTool,
  pressKeyTool,
  waitForTool,
  hoverTool,
  scrollTool,
  screenshotTool,
  consoleTool,
  networkTool,
  tabsTool,
  dragTool,
  resizeTool,
  waitForDownloadTool,
  highlightTool,
  getBoundingBoxTool,
  cdpTool,
  lockTool,
]
