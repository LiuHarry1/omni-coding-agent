/**
 * Single source of truth for transcript density.
 *
 * Cards should call `useToolDensityExpand(kind, ctx)` + `resolveChevron(kind, ctx)`
 * instead of inventing per-file showChevron / expandOnceWhen ternaries.
 *
 * Kinds:
 *   explore-group — Exploring / Explored 1 file, 1 search, 3 browser actions
 *   browser-group — Running / Ran N browser actions
 *                   (both: chevron; stay one line while running — only the
 *                   header summary updates; expand on error / user)
 *   subagent      — Explorer / Plan / Task (chevron if hasBody; open while running)
 *   explore-line  — Grep / Glob / ListDir / Web* under explore density
 *                   (collapsed by default; expand on error or user; chevron if hasBody)
 *   read          — success text = header-only (open file); images/errors expand
 *   shell         — Bash: open while live output; done collapses unless error
 *                   (success output stays user-expandable, not auto-open)
 *   interactive   — Ask / Plan approval style (not used via ToolChrome often)
 *   default       — MCP / unknown: open while running; collapse when done
 */

/** @typedef {'explore-group'|'browser-group'|'subagent'|'explore-line'|'read'|'shell'|'default'} DensityKind */

/**
 * @typedef {object} DensityContext
 * @property {boolean} [isDone]
 * @property {boolean} [isError]
 * @property {boolean} [nested]
 * @property {boolean} [hasBody]
 * @property {boolean} [isRunning] - explicit running (overrides !isDone)
 * @property {boolean} [hasLiveOutput] - shell streaming
 * @property {boolean} [isBackgrounded]
 * @property {boolean} [headerOnly] - read success text
 * @property {boolean} [forceExpandOnce] - e.g. image ready
 */

/**
 * @param {DensityKind} kind
 * @param {DensityContext} ctx
 * @returns {{ isRunning: boolean, expandOnceWhen: boolean }}
 */
export function resolveExpandArgs(kind, ctx = {}) {
  const isDone = Boolean(ctx.isDone)
  const isError = Boolean(ctx.isError)
  const nested = Boolean(ctx.nested)
  const isRunning = ctx.isRunning != null ? Boolean(ctx.isRunning) : !isDone
  const hasBody = ctx.hasBody !== false

  switch (kind) {
    case 'explore-group':
    case 'browser-group':
      return {
        isRunning: false,
        expandOnceWhen: isError,
      }
    case 'subagent':
      return {
        isRunning: isRunning && hasBody,
        expandOnceWhen: isError,
      }
    case 'read':
      return {
        isRunning: false,
        expandOnceWhen: Boolean(ctx.forceExpandOnce) || isError,
      }
    case 'explore-line':
      return {
        isRunning: false,
        expandOnceWhen: (isDone && isError) || Boolean(ctx.forceExpandOnce),
      }
    case 'shell':
      return {
        isRunning:
          isRunning && Boolean(ctx.hasLiveOutput) && !ctx.isBackgrounded,
        expandOnceWhen: isDone && !ctx.isBackgrounded && isError,
      }
    case 'default':
    default:
      return {
        isRunning: !nested && isRunning,
        expandOnceWhen: (isDone && isError) || Boolean(ctx.forceExpandOnce),
      }
  }
}

/**
 * @param {DensityKind} kind
 * @param {DensityContext} ctx
 * @returns {{ showChevron: boolean }}
 */
export function resolveChevron(kind, ctx = {}) {
  const hasBody = Boolean(ctx.hasBody)
  const headerOnly = Boolean(ctx.headerOnly)
  const isBackgrounded = Boolean(ctx.isBackgrounded)

  switch (kind) {
    case 'explore-group':
    case 'browser-group':
      return { showChevron: true }
    case 'read':
      return { showChevron: !headerOnly && hasBody }
    case 'shell':
      return { showChevron: !isBackgrounded && hasBody }
    case 'subagent':
    case 'explore-line':
    case 'default':
    default:
      return { showChevron: hasBody }
  }
}

/** Map tool name → density kind (overridden by TOOL_META.density when set). */
export const DEFAULT_DENSITY_BY_TOOL = {
  read: 'read',
  Read: 'read',
  grep: 'explore-line',
  Grep: 'explore-line',
  glob: 'explore-line',
  Glob: 'explore-line',
  list_dir: 'explore-line',
  list_directory: 'explore-line',
  web_search: 'explore-line',
  WebSearch: 'explore-line',
  search: 'explore-line',
  web_fetch: 'explore-line',
  WebFetch: 'explore-line',
  fetch: 'explore-line',
  bash: 'shell',
  Bash: 'shell',
  powershell: 'shell',
  PowerShell: 'shell',
}
