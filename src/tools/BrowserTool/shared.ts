/**
 * Shared plumbing for the `browser_*` tools: one output shape, one text
 * projection, one error funnel.
 *
 * Three-layer budgets:
 * - Capture fills complete YAML on BrowserToolOutput (no middle-omit)
 * - Over SNAPSHOT_INLINE_MAX_BYTES the full tree is spilled; mapBrowserOutput
 *   wraps remaining text to BROWSER_MODEL_RESULT_MAX_CHARS
 * - projectBrowserWireDetails builds SSE/session details without raw trees
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { z } from 'zod'
import { sinceReport } from '../../browser/page-inspect.js'
import {
  BROWSER_MODEL_RESULT_MAX_CHARS,
  DEFAULT_SNAPSHOT_DEPTH,
  EFFICIENT_MAX_CHARS,
  POST_ACTION_MAX_NODES,
  SCREENSHOT_TOKEN_BUDGET,
  SNAPSHOT_DIFF_INLINE_MAX_BYTES,
  SNAPSHOT_INLINE_MAX_BYTES,
  SNAPSHOT_PREVIEW_LINES,
  WIRE_CONSOLE_MAX,
  WIRE_DETAILS_MAX_BYTES,
  WIRE_DETAIL_STRING_MAX,
  WIRE_NETWORK_MAX,
} from '../../browser/limits.js'
import {
  getLastSnapshot,
  isSnapshotDegraded,
} from '../../browser/session-flags.js'
import { snapshotDiff } from '../../browser/snapshot-index.js'
import {
  formatSnapshotFileLine,
  snapshotPreviewLines,
} from '../../browser/distill-snapshot.js'
import * as pw from '../../browser/playwright/index.js'
import {
  BrowserError,
  type BrowserBackend,
  type NetworkEntry,
  type SnapshotMode,
} from '../../browser/types.js'
import { getBrowserLogsSessionDir } from '../../session/paths.js'
import type {
  ImageMediaType,
  ToolResultBlockParam,
  ToolResultContentBlockParam,
} from '../../core/types.js'
import {
  fitsApiImageLimit,
  toolResultImageBlockFromBuffer,
} from '../../utils/image/resize-buffer.js'

export interface NetworkRow {
  method: string
  url: string
  status: number
  ok: boolean
  pending: boolean
  failed: boolean
  error: string
  durationMs: number
}

export function toNetworkRow(e: NetworkEntry): NetworkRow {
  return {
    method: e.method,
    url: e.url,
    status: e.status,
    ok: e.ok,
    pending: e.pending,
    failed: e.failed,
    error: e.error,
    durationMs: e.durationMs,
  }
}

export interface BrowserPageState {
  truncated: boolean
  chars: number
  mode: SnapshotMode | 'text' | string
  artifactPath?: string
}

export interface BrowserToolOutput {
  action: string
  message: string
  url: string
  title: string
  /**
   * Model-only. Never put on the wire — projectBrowserWireDetails drops it.
   */
  snapshot?: string
  snapshotTruncated?: boolean
  snapshotMode?: SnapshotMode | 'text' | string
  snapshotArtifactPath?: string
  /** UTF-8 size of the complete YAML before preview spill. */
  snapshotFullBytes?: number
  snapshotTotalLines?: number
  pageState?: BrowserPageState
  consoleErrors?: Array<{ level: string; text: string }>
  network?: NetworkRow[]
  /** Set when `network` is a filtered view, so the card can say so. */
  networkTotal?: number
  tabs?: Array<{
    targetId: string
    url: string
    title: string
    current: boolean
  }>
  value?: unknown
  screenshotPath?: string
  /** Server-relative URL the UI can load the on-disk screenshot from. */
  screenshotUrl?: string
  /** Labeled-screenshot bounding boxes. */
  annotations?: Array<{
    ref: string
    number: number
    role: string
    name?: string
    box: { x: number; y: number; width: number; height: number }
  }>
  downloadPath?: string
  batchResults?: Array<{ ok: boolean; error?: string; url?: string }>
  /**
   * Intentionally absent from BrowserOutputSchema: the mapper reads it to build
   * the model's image block, then zod drops it before the UI ever sees it.
   */
  screenshotBase64?: string
  screenshotMediaType?: ImageMediaType
}

const PageStateSchema = z.object({
  truncated: z.boolean(),
  chars: z.number(),
  mode: z.string(),
  artifactPath: z.string().optional(),
})

/** Wire / session schema — no raw snapshot strings. */
export const BrowserOutputSchema = z.object({
  action: z.string(),
  message: z.string(),
  url: z.string(),
  title: z.string(),
  pageState: PageStateSchema.optional(),
  snapshotTruncated: z.boolean().optional(),
  consoleErrors: z
    .array(z.object({ level: z.string(), text: z.string() }))
    .optional(),
  network: z
    .array(
      z.object({
        method: z.string(),
        url: z.string(),
        status: z.number(),
        ok: z.boolean(),
        pending: z.boolean(),
        failed: z.boolean(),
        error: z.string(),
        durationMs: z.number(),
      }),
    )
    .optional(),
  networkTotal: z.number().optional(),
  tabs: z
    .array(
      z.object({
        targetId: z.string(),
        url: z.string(),
        title: z.string(),
        current: z.boolean(),
      }),
    )
    .optional(),
  value: z.unknown().optional(),
  screenshotPath: z.string().optional(),
  screenshotUrl: z.string().optional(),
  annotations: z
    .array(
      z.object({
        ref: z.string(),
        number: z.number(),
        role: z.string(),
        name: z.string().optional(),
        box: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      }),
    )
    .optional(),
  downloadPath: z.string().optional(),
  batchResults: z
    .array(
      z.object({
        ok: z.boolean(),
        error: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
})

/** Per-tab watermark so each action reports only the console output it caused. */
const consoleWatermark = new Map<string, number>()

export function resetConsoleWatermark(targetId: string): void {
  consoleWatermark.delete(targetId)
}

const MODEL_TRUNCATION_MARKER =
  '\n[truncated — retry browser_snapshot (raise maxDepth / mode=full) or browser_get_text]'

export function wrapModelToolText(
  text: string,
  maxChars: number = BROWSER_MODEL_RESULT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text
  const budget = Math.max(0, maxChars - MODEL_TRUNCATION_MARKER.length)
  return `${text.slice(0, budget)}${MODEL_TRUNCATION_MARKER}`
}

function wireTruncateString(
  value: string,
  max = WIRE_DETAIL_STRING_MAX,
): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function wireTruncateUnknown(
  value: unknown,
  max = WIRE_DETAIL_STRING_MAX,
): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === 'string') return wireTruncateString(value, max)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  try {
    const raw = JSON.stringify(value)
    if (raw.length <= max) return value
    return {
      truncated: true,
      preview: wireTruncateString(raw, max),
      originalChars: raw.length,
    }
  } catch {
    return wireTruncateString(String(value), max)
  }
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Persist a snapshot sidecar when the complete YAML exceeds the 25.6KB
 * inline cap. The file is the full tree (including middle form fields). The
 * model-facing `snapshot` is replaced with the first SNAPSHOT_PREVIEW_LINES.
 */
export async function maybePersistSnapshotArtifact(
  out: BrowserToolOutput,
  sessionId: string | undefined,
  toolCallId: string,
): Promise<void> {
  if (!out.snapshot || !sessionId) return
  const full = out.snapshot
  const bytes = Buffer.byteLength(full, 'utf8')
  if (bytes <= SNAPSHOT_INLINE_MAX_BYTES) return
  if (out.snapshotArtifactPath) return

  const dir = getBrowserLogsSessionDir(sessionId)
  await fs.mkdir(dir, { recursive: true })
  const name = `snapshot-${toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, full, 'utf8')
  out.snapshotArtifactPath = filePath
  out.snapshotFullBytes = bytes
  const { preview, totalLines } = snapshotPreviewLines(
    full,
    SNAPSHOT_PREVIEW_LINES,
  )
  out.snapshot = preview
  out.snapshotTruncated = true
  out.snapshotTotalLines = totalLines
}

export function attachPageState(out: BrowserToolOutput): void {
  if (out.snapshot === undefined && !out.pageState) return
  const mode =
    out.snapshotMode ?? (out.snapshot !== undefined ? 'efficient' : 'none')
  out.pageState = {
    truncated: Boolean(out.snapshotTruncated),
    chars: out.snapshot?.length ?? out.pageState?.chars ?? 0,
    mode,
    ...(out.snapshotArtifactPath
      ? { artifactPath: out.snapshotArtifactPath }
      : out.pageState?.artifactPath
        ? { artifactPath: out.pageState.artifactPath }
        : {}),
  }
}

/**
 * Build the compact UI/session payload. Never includes `snapshot` or base64.
 */
export function projectBrowserWireDetails(
  output: unknown,
): Record<string, unknown> {
  const out = (output ?? {}) as BrowserToolOutput
  attachPageState(out)

  const projected: Record<string, unknown> = {
    action: wireTruncateString(String(out.action ?? '')),
    message: wireTruncateString(String(out.message ?? '')),
    url: wireTruncateString(String(out.url ?? '')),
    title: wireTruncateString(String(out.title ?? '')),
  }

  if (out.pageState) {
    projected.pageState = {
      truncated: out.pageState.truncated,
      chars: out.pageState.chars,
      mode: wireTruncateString(String(out.pageState.mode), 64),
      ...(out.pageState.artifactPath
        ? { artifactPath: wireTruncateString(out.pageState.artifactPath) }
        : {}),
    }
  }
  if (out.snapshotTruncated !== undefined) {
    projected.snapshotTruncated = out.snapshotTruncated
  }
  if (out.consoleErrors?.length) {
    projected.consoleErrors = out.consoleErrors
      .slice(0, WIRE_CONSOLE_MAX)
      .map(e => ({
        level: wireTruncateString(e.level, 32),
        text: wireTruncateString(e.text),
      }))
  }
  if (out.network?.length) {
    projected.network = out.network.slice(0, WIRE_NETWORK_MAX).map(r => ({
      method: wireTruncateString(r.method, 16),
      url: wireTruncateString(r.url),
      status: r.status,
      ok: r.ok,
      pending: r.pending,
      failed: r.failed,
      error: wireTruncateString(r.error, 240),
      durationMs: r.durationMs,
    }))
  }
  if (out.networkTotal !== undefined) projected.networkTotal = out.networkTotal
  if (out.tabs?.length) {
    projected.tabs = out.tabs.slice(0, 40).map(t => ({
      targetId: wireTruncateString(t.targetId, 128),
      url: wireTruncateString(t.url),
      title: wireTruncateString(t.title, 240),
      current: t.current,
    }))
  }
  if (out.value !== undefined) {
    projected.value = wireTruncateUnknown(out.value)
  }
  if (out.screenshotPath) {
    projected.screenshotPath = wireTruncateString(out.screenshotPath)
  }
  if (out.screenshotUrl) {
    projected.screenshotUrl = wireTruncateString(out.screenshotUrl)
  }
  if (out.annotations?.length) {
    projected.annotations = out.annotations.slice(0, 40).map(a => ({
      ref: wireTruncateString(a.ref, 32),
      number: a.number,
      role: wireTruncateString(a.role, 64),
      ...(a.name ? { name: wireTruncateString(a.name, 120) } : {}),
      box: a.box,
    }))
  }
  if (out.downloadPath) {
    projected.downloadPath = wireTruncateString(out.downloadPath)
  }
  if (out.batchResults?.length) {
    projected.batchResults = out.batchResults.slice(0, 50).map(r => ({
      ok: r.ok,
      ...(r.error ? { error: wireTruncateString(r.error, 240) } : {}),
      ...(r.url ? { url: wireTruncateString(r.url) } : {}),
    }))
  }

  let serialized = JSON.stringify(projected)
  if (utf8Bytes(serialized) <= WIRE_DETAILS_MAX_BYTES) return projected

  // Drop heavier optional arrays first, then hard-truncate message/value.
  delete projected.annotations
  delete projected.batchResults
  delete projected.network
  delete projected.consoleErrors
  delete projected.tabs
  if (projected.value !== undefined) {
    projected.value = wireTruncateUnknown(projected.value, 200)
  }
  projected.message = wireTruncateString(String(projected.message ?? ''), 200)
  serialized = JSON.stringify(projected)
  if (utf8Bytes(serialized) > WIRE_DETAILS_MAX_BYTES) {
    return {
      action: projected.action,
      message: wireTruncateString(String(projected.message ?? ''), 120),
      url: wireTruncateString(String(projected.url ?? ''), 240),
      title: wireTruncateString(String(projected.title ?? ''), 120),
      pageState: projected.pageState,
      wireTruncated: true,
    }
  }
  projected.wireTruncated = true
  return projected
}

/**
 * Gather everything the model needs to decide its next move: where it ended up,
 * what the page looks like now, and whether the action broke anything.
 */
export async function observe(
  backend: BrowserBackend,
  targetId: string,
  opts: {
    action: string
    message: string
    withSnapshot?: boolean
    maxNodes?: number
    maxChars?: number
    selector?: string
    /** Internal shorthand for `mode: 'efficient'`, which `mode` overrides. */
    compact?: boolean
    interactive?: boolean
    includeDiff?: boolean
    urls?: boolean
    skipIfDegraded?: boolean
    mode?: SnapshotMode
    depth?: number
    sessionId?: string
    toolCallId?: string
  },
): Promise<BrowserToolOutput> {
  const mode: SnapshotMode = opts.mode ?? (opts.compact ? 'efficient' : 'full')
  const efficient = mode === 'efficient'
  // Compact budgeting and interactive-only filtering stay orthogonal.
  // Post-action snapshots need status text such as "saved" or an uploaded file
  // name, so only an explicit interactive=true may remove content nodes.
  const interactive = opts.interactive ?? false
  const maxChars = efficient
    ? (opts.maxChars ?? EFFICIENT_MAX_CHARS)
    : opts.maxChars
  const maxNodes = efficient
    ? (opts.maxNodes ?? POST_ACTION_MAX_NODES)
    : opts.maxNodes
  const depth = opts.depth ?? DEFAULT_SNAPSHOT_DEPTH

  const out: BrowserToolOutput = {
    action: opts.action,
    message: opts.message,
    url: '',
    title: '',
    snapshotMode: mode,
  }

  const dialog = await pw
    .peekNativeDialog(backend, targetId)
    .catch(() => undefined)
  const pageFrozen = Boolean(dialog?.pending)
  const skipSnap =
    opts.withSnapshot === false ||
    pageFrozen ||
    (opts.skipIfDegraded && isSnapshotDegraded(targetId))

  if (!skipSnap) {
    const previous = opts.includeDiff ? getLastSnapshot(targetId) : undefined
    const snap = await pw.snapshot(backend, targetId, {
      maxNodes,
      maxChars,
      selector: opts.selector,
      interactive,
      urls: opts.urls,
      depth,
      mode,
    })
    out.url = snap.url
    out.title = snap.title
    if (opts.includeDiff && previous) {
      const diff = snapshotDiff(previous, snap.text)
      const diffBytes = Buffer.byteLength(diff, 'utf8')
      if (diffBytes > SNAPSHOT_DIFF_INLINE_MAX_BYTES) {
        out.snapshot = snap.text
        out.message = `${out.message} (snapshot diff too large to include inline (${diffBytes} bytes))`
      } else {
        out.snapshot = diff
      }
    } else {
      out.snapshot = snap.text
    }
    out.snapshotTruncated = snap.truncated
    if (opts.sessionId && opts.toolCallId) {
      await maybePersistSnapshotArtifact(out, opts.sessionId, opts.toolCallId)
    }
    attachPageState(out)
  } else {
    const tabs = await backend.listTabs()
    const tab = tabs.find(t => t.targetId === targetId)
    out.url = tab?.url ?? ''
    out.title = tab?.title ?? ''
    if (opts.skipIfDegraded && isSnapshotDegraded(targetId)) {
      out.message = `${out.message} (snapshot skipped — page still degraded from a PDF/iframe stall; keep filling the main form with click/type/fill-form, do not loop on screenshot or full snapshot)`
    }
  }

  if (!pageFrozen) {
    const since = consoleWatermark.get(targetId)
    const report = await Promise.race([
      sinceReport(backend, targetId, since),
      new Promise<null>(r => setTimeout(() => r(null), 2_000)),
    ])
    if (report) {
      consoleWatermark.set(targetId, report.now)
      if (report.logs.length) {
        out.consoleErrors = report.logs.map(e => ({
          level: e.level,
          text: e.text,
        }))
      }
      if (report.network.length) {
        out.network = report.network.map(toNetworkRow)
      }
    }
  }

  if (dialog) {
    const fate = dialog.pending
      ? 'still open — call browser_handle_dialog'
      : dialog.accepted
        ? 'accepted'
        : 'dismissed (call browser_handle_dialog before the next such click to accept)'
    out.message = `${out.message} (native ${dialog.type} dialog: ${JSON.stringify(dialog.message)} — ${fate})`
  }

  return out
}

export async function attachScreenshot(
  out: BrowserToolOutput,
  shot: { buffer: Buffer; format: 'png' | 'jpeg' },
  sessionId: string | undefined,
  toolCallId: string,
): Promise<void> {
  const mediaType: ImageMediaType =
    shot.format === 'jpeg' ? 'image/jpeg' : 'image/png'

  // Full-fidelity copy on disk for the UI card; the model gets a downsampled
  // one so a 3MB retina PNG can't eat the context window.
  if (sessionId) {
    const dir = getBrowserLogsSessionDir(sessionId)
    await fs.mkdir(dir, { recursive: true })
    const name = `${toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${shot.format}`
    await fs.writeFile(path.join(dir, name), shot.buffer)
    out.screenshotPath = path.join(dir, name)
    out.screenshotUrl = `/sessions/${encodeURIComponent(sessionId)}/browser/${name}`
  }

  try {
    const block = await toolResultImageBlockFromBuffer(shot.buffer, mediaType, {
      maxTokens: SCREENSHOT_TOKEN_BUDGET,
      strictBudget: true,
    })
    out.screenshotBase64 = block.source.data
    out.screenshotMediaType = block.source.media_type
  } catch (err) {
    if (fitsApiImageLimit(shot.buffer)) {
      out.screenshotBase64 = shot.buffer.toString('base64')
      out.screenshotMediaType = mediaType
      return
    }
    const reason = err instanceof Error ? err.message : String(err)
    out.message = `${out.message} (model image omitted: ${reason})`
  }
}

/**
 * The distinction worth spending characters on: a request that came back 500
 * reached the server, one that "never sent" did not. They have different fixes.
 */
function renderNetworkRow(r: NetworkRow): string {
  const status = r.pending ? '...' : r.failed ? 'ERR' : String(r.status)
  const head = `${status.padStart(3)}  ${r.method.padEnd(6)}${r.url}`
  if (r.pending) return `${head}  (still pending)`
  if (r.failed) {
    const aborted = /abort|signal/i.test(r.error)
    return aborted
      ? `${head}  (${r.durationMs}ms) — aborted: ${r.error}`
      : `${head}  (${r.durationMs}ms) — never sent: ${r.error}`
  }
  return `${head}  (${r.durationMs}ms)`
}

function renderText(out: BrowserToolOutput): string {
  const lines: string[] = [out.message]

  if (out.url) {
    lines.push(`Page: ${out.url}${out.title ? ` — ${out.title}` : ''}`)
  }

  if (out.tabs?.length) {
    lines.push('')
    lines.push('Open tabs:')
    for (const t of out.tabs) {
      lines.push(
        `  ${t.current ? '*' : ' '} ${t.targetId}  ${t.title || '(untitled)'}  ${t.url}`,
      )
    }
  }

  if (out.value !== undefined) {
    lines.push('')
    lines.push(`Result: ${JSON.stringify(out.value, null, 2)}`)
  }

  if (out.consoleErrors?.length) {
    lines.push('')
    // browser_console reuses this list for its full, all-level listing.
    const heading =
      out.action === 'console'
        ? 'Console messages'
        : 'Console errors during this action'
    lines.push(`${heading} (${out.consoleErrors.length}):`)
    for (const e of out.consoleErrors) lines.push(`  [${e.level}] ${e.text}`)
  }

  if (out.network?.length) {
    lines.push('')
    const shown = out.network.length
    lines.push(
      out.networkTotal !== undefined
        ? `Network requests (${shown} of ${out.networkTotal}):`
        : `Failed requests during this action (${shown}):`,
    )
    for (const r of out.network) lines.push(`  ${renderNetworkRow(r)}`)
  }

  if (out.downloadPath) {
    lines.push('')
    lines.push(`Download saved to ${out.downloadPath}`)
  }

  if (out.batchResults?.length) {
    lines.push('')
    lines.push(`Batch results (${out.batchResults.length}):`)
    for (const row of out.batchResults) {
      lines.push(row.ok ? '  ok' : `  fail: ${row.error ?? 'unknown'}`)
    }
  }

  if (out.annotations?.length) {
    lines.push('')
    lines.push(`Label annotations (${out.annotations.length}):`)
    for (const a of out.annotations.slice(0, 40)) {
      lines.push(
        `  ${a.ref} ${a.role}${a.name ? ` "${a.name}"` : ''} box=${a.box.x},${a.box.y} ${a.box.width}x${a.box.height}`,
      )
    }
  }

  if (out.screenshotPath) {
    lines.push('')
    lines.push(`Screenshot saved to ${out.screenshotPath}`)
  }

  if (out.snapshotArtifactPath) {
    lines.push('')
    const bytes = out.snapshotFullBytes ?? 0
    const total = out.snapshotTotalLines ?? 0
    const previewLines = (out.snapshot ?? '').split('\n').length
    lines.push(
      `Page Snapshot: Large snapshot (${bytes} bytes, ${total} lines) written to file`,
    )
    lines.push(formatSnapshotFileLine(out.snapshotArtifactPath))
    lines.push(
      `Preview (first ${previewLines} lines). Read the Snapshot File path exactly. Middle form fields are in the file, not missing.`,
    )
  }

  if (out.snapshot !== undefined) {
    lines.push('')
    lines.push('Page snapshot:')
    lines.push(out.snapshot || '(no visible content)')
    if (
      out.snapshotTruncated &&
      !(
        out.snapshotFullBytes &&
        out.snapshotFullBytes > SNAPSHOT_INLINE_MAX_BYTES
      )
    ) {
      lines.push(
        '… snapshot truncated. Named controls may be missing. Call browser_snapshot again (raise maxDepth, pass selector, or mode=full). Do not treat an empty generic as unautomatable.',
      )
    } else if (
      out.snapshotTruncated &&
      out.snapshotTotalLines &&
      out.snapshotTotalLines > SNAPSHOT_PREVIEW_LINES
    ) {
      lines.push(
        `... (${out.snapshotTotalLines - SNAPSHOT_PREVIEW_LINES} more lines in file)`,
      )
    }
  }

  return lines.join('\n')
}

export function mapBrowserOutput(
  output: unknown,
  toolUseID: string,
): ToolResultBlockParam {
  const out = output as BrowserToolOutput
  const text = wrapModelToolText(renderText(out))

  if (out.screenshotBase64 && out.screenshotMediaType) {
    const content: ToolResultContentBlockParam[] = [
      { type: 'text', text },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: out.screenshotMediaType,
          data: out.screenshotBase64,
        },
      },
    ]
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  }

  return { tool_use_id: toolUseID, type: 'tool_result', content: text }
}

/**
 * Browser failures are almost always recoverable by re-observing the page, so
 * they come back as tool text rather than thrown errors. We do not dump a YAML
 * tree here — a short classified error plus Recovery action forces a dedicated
 * snapshot so refs stay canonical.
 */
const RECOVERY_RULES: Array<{
  patterns: string[]
  suggestion: string
  recovery: string
}> = [
  {
    patterns: ['not rendering this tab'],
    suggestion:
      'Snapshots and retries cannot fix this; only the user can restore the Chrome window.',
    recovery: 'stop and ask the user to restore the Chrome window',
  },
  {
    // browser_mouse_click_xy: coordinates come from a screenshot, not refs.
    patterns: [
      'needs a fresh viewport screenshot',
      'needs a fresh screenshot',
      'outside the latest screenshot',
      'outside viewport',
      'does not hit a page element',
    ],
    suggestion:
      'Take a new screenshot for this tab, then retry with coordinates from it.',
    recovery: 'browser_screenshot without ref or labels',
  },
  {
    patterns: [
      'element not found',
      'cannot find',
      'not found in the current page snapshot',
      'stale',
      'detached',
    ],
    suggestion:
      'The page content has changed since the last snapshot. Take a new snapshot to get updated refs. Do not retry the same ref.',
    recovery: 'browser_snapshot',
  },
  {
    patterns: ['hit an iframe'],
    suggestion:
      'The click hit an iframe. Snapshot again and use the inner control ref (fNeM), not the iframe chrome.',
    recovery: 'browser_snapshot',
  },
  {
    patterns: ['modal', 'dialog', 'overlay', 'blocked by'],
    suggestion:
      'Close the overlay first, then snapshot and retry the original control.',
    recovery: 'browser_snapshot to refresh refs',
  },
  {
    patterns: ['no <input type=file>', 'not an <input type=file>'],
    suggestion:
      'Do not click a visible Upload. Call browser_file_upload with paths only (omit ref).',
    recovery: 'browser_file_upload with paths only (omit ref)',
  },
  {
    patterns: ['timeout', 'timed out'],
    suggestion:
      'The page might be slow. Snapshot to check the current state rather than waiting again.',
    recovery: 'browser_snapshot',
  },
  {
    patterns: ['no browser tab', 'navigate to a page first'],
    suggestion: 'Open or select a tab before interacting.',
    recovery: 'browser_tabs with action "list", then browser_navigate',
  },
]

export function recoverySuffixForError(message: string): string {
  if (/Recovery action:/i.test(message)) return ''
  const lower = message.toLowerCase()
  const rule = RECOVERY_RULES.find(r => r.patterns.some(p => lower.includes(p)))
  const suggestion =
    rule?.suggestion ??
    'Take a snapshot to see the current page, then retry with a fresh ref.'
  const recovery = rule?.recovery ?? 'browser_snapshot'
  return `${suggestion}\nRecovery action: ${recovery}`
}

export function browserErrorText(
  err: unknown,
  action: string,
  _freshSnapshot?: string,
): string {
  const head =
    err instanceof BrowserError
      ? `Error: ${err.message}`
      : `Error: ${action} failed: ${err instanceof Error ? err.message : String(err)}`
  const suffix = recoverySuffixForError(head)
  return wrapModelToolText(suffix ? `${head}\n\n${suffix}` : head)
}
