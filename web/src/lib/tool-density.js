/**
 * Chat density helpers.
 *
 * Explored groups only fold built-in explore tools and `browser_*` steps —
 * never real MCP calls (merged as `${server}_${tool}` in mcp-manager).
 * A run of only `browser_*` tools folds into a `browser-group`
 * (`Ran N browser actions`, N ≥ 2); a mixed run reads
 * `Explored 1 file, 1 search, 3 browser actions`.
 */

import { isPlanFileWrite } from './plan-utils.js'
import {
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  TODO_WRITE,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  LSP,
  ASK_USER_QUESTION,
  TOOL_SEARCH,
  SKILL,
  AGENT,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
  TASK_OUTPUT,
  TASK_STOP,
  CRON_CREATE,
  CRON_LIST,
  CRON_DELETE,
  SUPPRESSED_TOOL_CARDS,
} from './tool-names.js'
import { EXPLORE_GROUPABLE_NAMES } from './tool-registry-meta.js'

/** All first-party tool names the agent registers (not MCP). */
export const BUILT_IN_TOOLS = new Set([
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  TODO_WRITE,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  LSP,
  ASK_USER_QUESTION,
  TOOL_SEARCH,
  SKILL,
  AGENT,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
  TASK_OUTPUT,
  TASK_STOP,
  CRON_CREATE,
  CRON_LIST,
  CRON_DELETE,
  // legacy / alt spellings seen in older transcripts
  'bash',
  'powershell',
  'write_file',
  'edit_file',
  'list_directory',
  'fetch',
  'search',
])

/**
 * Built-ins that fold into "Explored N tools".
 * Derived from TOOL_META.exploreGroupable in tool-registry-meta.js.
 */
export const EXPLORE_BUILTINS = EXPLORE_GROUPABLE_NAMES

/**
 * Pure read/ls groups need ≥ 3 steps before folding.
 * Grep / glob / web mix folds at N ≥ 2.
 */
const PURE_FILE_EXPLORE_NAMES = new Set([
  READ,
  'read',
  LIST_DIR,
  'list_directory',
])
const PURE_FILE_EXPLORE_MIN = 3
const BROWSER_GROUP_MIN = 2
const EXPLORE_GROUP_MIN = 2

/** tool_call parts and transcript tool bubbles share name / isSubagent. */
function isToolish(item) {
  if (!item) return false
  if (item.type && item.type !== 'tool_call') return false
  if (item.kind && item.kind !== 'tool') return false
  return typeof item.name === 'string'
}

export function isExploreTool(part) {
  if (!isToolish(part) || part.isSubagent) return false
  if (part.name === SKILL) return false
  return EXPLORE_GROUPABLE_NAMES.has(part.name)
}

/** Playwright / agent browser_* family — high-churn automation steps. */
export function isBrowserTool(part) {
  if (!isToolish(part) || part.isSubagent) return false
  return part.name.startsWith('browser_')
}

function isPureFileExplore(buf) {
  return buf.length > 0 && buf.every(p => PURE_FILE_EXPLORE_NAMES.has(p.name))
}

/**
 * MCP tools are merged as `${server}_${tool}` and are never in BUILT_IN_TOOLS.
 * Subagents / skills are excluded even if the name is unusual.
 */
export function isMcpTool(part) {
  if (!isToolish(part) || part.isSubagent) return false
  if (part.name === SKILL) return false
  if (isBrowserTool(part)) return false
  return !BUILT_IN_TOOLS.has(part.name)
}

/**
 * Coalesce consecutive explore / browser built-ins into density groups.
 * Explore and browser steps share one run; it becomes a `browser_run` only
 * when every member is `browser_*`.
 *
 * Subagents are deliberately NOT coalesced: they always render as their own
 * row (`isSubagent` parts are excluded from the groupable set and force-flush
 * the pending group). Turn-level folding is WorkGroup's job.
 *
 * @param {object[]} items tool_call parts or tool bubbles
 * @returns {Array<{ type: 'explored_run'|'browser_run', items: object[] } | { type: 'tool', part: object }>}
 */
export function coalesceToolRuns(items) {
  const out = []
  let buf = []

  const flush = () => {
    if (buf.length === 0) return
    const allBrowser = buf.every(isBrowserTool)
    const min = allBrowser
      ? BROWSER_GROUP_MIN
      : isPureFileExplore(buf)
        ? PURE_FILE_EXPLORE_MIN
        : EXPLORE_GROUP_MIN
    if (buf.length < min) {
      for (const part of buf) out.push({ type: 'tool', part })
    } else {
      out.push({
        type: allBrowser ? 'browser_run' : 'explored_run',
        items: buf,
      })
    }
    buf = []
  }

  for (const part of items) {
    if (isBrowserTool(part) || isExploreTool(part)) {
      buf.push(part)
    } else {
      flush()
      out.push({ type: 'tool', part })
    }
  }
  flush()
  return out
}

/**
 * Filter suppressed / plan-file writes, then coalesce explore / browser runs.
 * Used by nested Skill / Agent step lists — not the main transcript.
 *
 * @param {object[]} items tool_call parts
 * @returns {{ runs: ReturnType<typeof coalesceToolRuns>, waiting: boolean }}
 */
export function expandToolGroup(items) {
  const visibleItems = (items || []).filter(
    it =>
      isToolish(it) &&
      !SUPPRESSED_TOOL_CARDS.has(it.name) &&
      !isPlanFileWrite(it),
  )
  if (visibleItems.length === 0) {
    return { runs: [], waiting: false }
  }
  return {
    runs: coalesceToolRuns(visibleItems),
    waiting: hasRunningSubagent(visibleItems),
  }
}

/** True when any subagent (Agent / Skill fork) is still running. */
export function hasRunningSubagent(items) {
  return (items || []).some(
    p => isToolish(p) && p.isSubagent && p.status !== 'done',
  )
}

/** Short live status for a tool_call (Explored / Subagent subtitle). */
export function liveToolSubtitle(part) {
  if (!part) return ''
  const name = part.name || 'tool'
  if (typeof name === 'string' && name.startsWith('browser_')) {
    const action = name.slice('browser_'.length).replace(/_/g, ' ')
    return part.status === 'done' ? action : `${action}\u2026`
  }
  const args = part.args || {}
  const path =
    args.file_path ||
    args.path ||
    args.directory ||
    (typeof args.pattern === 'string' ? args.pattern : null) ||
    (typeof args.query === 'string' ? args.query : null) ||
    (typeof args.url === 'string' ? args.url : null) ||
    (typeof args.command === 'string' ? args.command : null)

  const verb =
    name === READ || name === 'read'
      ? 'Reading'
      : name === GREP
        ? 'Grepping'
        : name === GLOB
          ? 'Globbing'
          : name === LIST_DIR || name === 'list_directory'
            ? 'Listing'
            : name === WEB_SEARCH || name === 'search'
              ? 'Searching'
              : name === WEB_FETCH || name === 'fetch'
                ? 'Fetching'
                : name === TOOL_SEARCH
                  ? 'ToolSearch'
                  : name === BASH || name === POWERSHELL
                    ? 'Running'
                    : `${name}`

  if (path) {
    const short =
      typeof path === 'string' && path.length > 48
        ? `${path.slice(0, 45)}\u2026`
        : path
    return `${verb} ${short}`
  }
  return part.status === 'done' ? name : `${verb}\u2026`
}

/**
 * Latest in-flight member, else the last member — for Explored live subtitle.
 */
export function pickLiveMember(items) {
  if (!Array.isArray(items) || items.length === 0) return null
  const running = [...items].reverse().find(p => p.status !== 'done')
  return running || items[items.length - 1]
}

/** Compact "3 reads, 2 searches" mix for done Explored / subagent rows. */
export function summarizeToolSteps(steps) {
  const counts = {}
  for (const s of steps || []) {
    const n = s.name || 'other'
    let bucket = n
    if (typeof n === 'string' && n.startsWith('browser_'))
      bucket = '__browser__'
    else if (n.endsWith('_fetch')) bucket = '__fetch__'
    else if (n.endsWith('_search') || n.endsWith('_web_search'))
      bucket = '__search__'
    counts[bucket] = (counts[bucket] || 0) + 1
  }
  const VERBS = [
    [READ, 'read', 'reads'],
    [GREP, 'search', 'searches'],
    [GLOB, 'glob', 'globs'],
    [LIST_DIR, 'dir', 'dirs'],
    ['list_directory', 'dir', 'dirs'],
    [BASH, 'cmd', 'cmds'],
    [POWERSHELL, 'cmd', 'cmds'],
    [WEB_SEARCH, 'web search', 'web searches'],
    ['__search__', 'web search', 'web searches'],
    [WEB_FETCH, 'fetch', 'fetches'],
    ['__fetch__', 'fetch', 'fetches'],
    ['__browser__', 'browser action', 'browser actions'],
    [WRITE, 'write', 'writes'],
    [EDIT, 'edit', 'edits'],
    [SKILL, 'skill', 'skills'],
    [TOOL_SEARCH, 'tool search', 'tool searches'],
  ]
  const phrases = []
  for (const [key, sing, plur] of VERBS) {
    if (counts[key])
      phrases.push(`${counts[key]} ${counts[key] > 1 ? plur : sing}`)
  }
  if (phrases.length === 0) return null
  // e.g. "3 searches, 17 browser actions"
  return phrases.join(', ')
}

/**
 * Collapsed explore line details.
 * Prefer "9 files" / "1 file, 1 search, 3 browser actions" —
 * never "1 read, 1 search, 1 tool search".
 */
export function summarizeExploredDetails(steps) {
  const list = (steps || []).filter(s => s.name !== TOOL_SEARCH)
  if (list.length === 0) {
    const n = (steps || []).length
    return n > 0 ? `${n} tool${n === 1 ? '' : 's'}` : null
  }

  const isBrowserStep = s =>
    typeof s.name === 'string' && s.name.startsWith('browser_')

  if (list.every(isBrowserStep)) {
    const n = list.length
    return `${n} browser action${n === 1 ? '' : 's'}`
  }

  let files = 0
  let searches = 0
  let webSearches = 0
  let fetches = 0
  let browserActions = 0
  let other = 0

  for (const s of list) {
    const n = s.name
    if (n === READ || n === GLOB || n === LIST_DIR || n === 'list_directory') {
      files += 1
    } else if (n === GREP) {
      searches += 1
    } else if (n === WEB_SEARCH || n === 'search') {
      webSearches += 1
    } else if (n === WEB_FETCH || n === 'fetch') {
      fetches += 1
    } else if (isBrowserStep(s)) {
      browserActions += 1
    } else {
      other += 1
    }
  }

  // Pure file reads/globs/ls → "9 files" (default chat).
  if (files === list.length) {
    return `${files} file${files === 1 ? '' : 's'}`
  }
  if (searches === list.length) {
    return `${searches} search${searches === 1 ? '' : 'es'}`
  }

  const phrases = []
  if (files > 0) phrases.push(`${files} file${files === 1 ? '' : 's'}`)
  if (searches > 0)
    phrases.push(`${searches} search${searches === 1 ? '' : 'es'}`)
  if (webSearches > 0)
    phrases.push(`${webSearches} web search${webSearches === 1 ? '' : 'es'}`)
  if (fetches > 0) phrases.push(`${fetches} fetch${fetches === 1 ? '' : 'es'}`)
  if (browserActions > 0)
    phrases.push(
      `${browserActions} browser action${browserActions === 1 ? '' : 's'}`,
    )
  if (other > 0 && phrases.length === 0) {
    return summarizeToolSteps(list)
  }
  return phrases.length > 0 ? phrases.join(', ') : summarizeToolSteps(list)
}

export function detectToolError(part) {
  if (!part || part.status !== 'done') return false
  if (part.isError) return true
  const r = part.result
  return typeof r === 'string' && r.startsWith('Error:')
}
