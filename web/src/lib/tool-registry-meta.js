/**
 * Tool UI metadata — chrome, explore grouping, transcript suppress, density.
 * Safe for lib / density helpers (no React).
 */

import {
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  LSP,
  TOOL_SEARCH,
  SKILL,
  TODO_WRITE,
  ASK_USER_QUESTION,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
  TASK_OUTPUT,
  TASK_STOP,
  CRON_CREATE,
  CRON_LIST,
  CRON_DELETE,
  BROWSER_TOOLS,
} from './tool-names.js'

/** @typedef {'line' | 'card'} ToolChromeKind */
/** @typedef {import('./tool-density-policy.js').DensityKind} DensityKind */

/**
 * @typedef {object} ToolMetaEntry
 * @property {ToolChromeKind} chrome
 * @property {boolean} [exploreGroupable]
 * @property {boolean} [suppressTranscript] - hide tool_call row (shown elsewhere)
 * @property {boolean} [suppressInSubagent] - hide inside Explorer/Plan step lists
 * @property {DensityKind} [density]
 */

/** @type {Record<string, ToolMetaEntry>} */
export const TOOL_META = {
  [READ]: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'read',
  },
  [GREP]: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  [GLOB]: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  [LIST_DIR]: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  [WEB_SEARCH]: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  [WEB_FETCH]: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  [TOOL_SEARCH]: {
    chrome: 'line',
    suppressTranscript: true,
    suppressInSubagent: true,
    density: 'explore-line',
  },
  list_directory: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  fetch: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },
  search: {
    chrome: 'line',
    exploreGroupable: true,
    density: 'explore-line',
  },

  [BASH]: { chrome: 'line', density: 'shell' },
  [POWERSHELL]: { chrome: 'line', density: 'shell' },
  bash: { chrome: 'line', density: 'shell' },
  powershell: { chrome: 'line', density: 'shell' },
  [TASK_OUTPUT]: { chrome: 'line', density: 'default' },
  [TASK_STOP]: { chrome: 'line', density: 'default' },
  [LSP]: { chrome: 'line', density: 'default' },
  [CRON_CREATE]: { chrome: 'line', density: 'default' },
  [CRON_LIST]: { chrome: 'line', density: 'default' },
  [CRON_DELETE]: { chrome: 'line', density: 'default' },

  [WRITE]: { chrome: 'card' },
  [EDIT]: { chrome: 'card' },
  write_file: { chrome: 'card' },
  edit_file: { chrome: 'card' },

  [SKILL]: { chrome: 'line', density: 'subagent' },
  [TODO_WRITE]: {
    chrome: 'line',
    suppressTranscript: true,
    suppressInSubagent: true,
  },
  [ASK_USER_QUESTION]: {
    chrome: 'line',
    suppressTranscript: true,
  },
  [ENTER_PLAN_MODE]: {
    chrome: 'line',
    suppressTranscript: true,
  },
  [EXIT_PLAN_MODE]: {
    chrome: 'line',
    suppressTranscript: true,
  },

  ...Object.fromEntries(
    BROWSER_TOOLS.map(name => [
      name,
      { chrome: 'line', density: 'explore-line' },
    ]),
  ),
}

export const EXPLORE_GROUPABLE_NAMES = new Set(
  Object.entries(TOOL_META)
    .filter(([, m]) => m.exploreGroupable)
    .map(([name]) => name),
)

/**
 * Prefer TOOL_META.suppressTranscript. Re-exported helpers for density tests;
 * runtime suppress sets live in tool-names.js to avoid circular imports.
 */
export function listSuppressTranscriptNames() {
  return Object.entries(TOOL_META)
    .filter(([, m]) => m.suppressTranscript)
    .map(([name]) => name)
}

export function listSuppressInSubagentNames() {
  return Object.entries(TOOL_META)
    .filter(([, m]) => m.suppressInSubagent)
    .map(([name]) => name)
}

export function getToolMeta(name) {
  if (!name) return null
  return TOOL_META[name] ?? null
}

export function getToolChrome(name) {
  return getToolMeta(name)?.chrome ?? 'line'
}

export function getToolDensityKind(name) {
  const meta = getToolMeta(name)
  if (meta?.density) return meta.density
  return 'default'
}

export function isExploreGroupableName(name) {
  return EXPLORE_GROUPABLE_NAMES.has(name)
}
