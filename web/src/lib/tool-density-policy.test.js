/**
 * Density policy fixture tests.
 * Run: npx vitest run web/src/lib/tool-density-policy.test.js
 */
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { resolveExpandArgs, resolveChevron } from './tool-density-policy.js'
import {
  getToolDensityKind,
  listSuppressTranscriptNames,
  EXPLORE_GROUPABLE_NAMES,
} from './tool-registry-meta.js'
import {
  SUPPRESSED_TOOL_CARDS,
  TOOL_SEARCH,
  READ,
  GREP,
  LSP,
  CRON_LIST,
  BROWSER_NAVIGATE,
} from './tool-names.js'
import {
  summarizeExploredDetails,
  coalesceToolRuns,
  isMcpTool,
} from './tool-density.js'
import { sanitizeToolUpdatePayload } from './sanitize-tool-ui.js'
import { formatWorkedDuration } from './timeline.js'

describe('resolveExpandArgs', () => {
  it('explore-group stays one line while running and when done', () => {
    assert.deepEqual(
      resolveExpandArgs('explore-group', { isRunning: true, hasBody: true }),
      { isRunning: false, expandOnceWhen: false },
    )
    assert.deepEqual(resolveExpandArgs('explore-group', { isDone: true }), {
      isRunning: false,
      expandOnceWhen: false,
    })
  })

  it('explore-group expands once on error', () => {
    assert.equal(
      resolveExpandArgs('explore-group', { isDone: true, isError: true })
        .expandOnceWhen,
      true,
    )
  })

  it('explore-line never auto-opens on success', () => {
    const a = resolveExpandArgs('explore-line', {
      isDone: true,
      isError: false,
      hasBody: true,
    })
    assert.equal(a.isRunning, false)
    assert.equal(a.expandOnceWhen, false)
  })

  it('explore-line expands once on error', () => {
    const a = resolveExpandArgs('explore-line', {
      isDone: true,
      isError: true,
    })
    assert.equal(a.expandOnceWhen, true)
  })

  it('shell does not auto-open success output', () => {
    const a = resolveExpandArgs('shell', {
      isDone: true,
      isError: false,
      hasLiveOutput: false,
    })
    assert.equal(a.expandOnceWhen, false)
  })

  it('read expands once for images via forceExpandOnce', () => {
    const a = resolveExpandArgs('read', {
      isDone: true,
      forceExpandOnce: true,
    })
    assert.equal(a.expandOnceWhen, true)
  })
})

describe('resolveChevron', () => {
  it('explore-group always shows chevron', () => {
    assert.deepEqual(resolveChevron('explore-group', {}), {
      showChevron: true,
    })
  })

  it('read header-only never shows a chevron', () => {
    assert.deepEqual(
      resolveChevron('read', { nested: true, headerOnly: true, hasBody: true }),
      { showChevron: false },
    )
  })

  it('subagent shows chevron when hasBody', () => {
    assert.equal(
      resolveChevron('subagent', { hasBody: true }).showChevron,
      true,
    )
    assert.equal(
      resolveChevron('subagent', { hasBody: false }).showChevron,
      false,
    )
  })
})

describe('TOOL_META density', () => {
  it('maps Read/Grep to density kinds', () => {
    assert.equal(getToolDensityKind(READ), 'read')
    assert.equal(getToolDensityKind(GREP), 'explore-line')
    assert.equal(getToolDensityKind(BROWSER_NAVIGATE), 'explore-line')
  })

  it('keeps ToolSearch suppressed in sync with TOOL_META', () => {
    assert.ok(SUPPRESSED_TOOL_CARDS.has(TOOL_SEARCH))
    assert.ok(listSuppressTranscriptNames().includes(TOOL_SEARCH))
  })

  it('does not explore-group ToolSearch', () => {
    assert.equal(EXPLORE_GROUPABLE_NAMES.has(TOOL_SEARCH), false)
  })

  it('does not classify first-party LSP or Cron tools as MCP', () => {
    assert.equal(isMcpTool({ name: LSP }), false)
    assert.equal(isMcpTool({ name: CRON_LIST }), false)
    assert.equal(isMcpTool({ name: 'github_search' }), true)
  })
})

describe('summarizeExploredDetails', () => {
  it('formats mixed read+grep', () => {
    const s = summarizeExploredDetails([{ name: READ }, { name: GREP }])
    assert.equal(s, '1 file, 1 search')
  })

  it('formats pure reads as N files', () => {
    assert.equal(
      summarizeExploredDetails([{ name: READ }, { name: READ }]),
      '2 files',
    )
  })

  it('counts browser actions in a mixed explore run', () => {
    assert.equal(
      summarizeExploredDetails([
        { name: READ },
        { name: GREP },
        { name: BROWSER_NAVIGATE },
        { name: 'browser_snapshot' },
        { name: 'browser_click' },
      ]),
      '1 file, 1 search, 3 browser actions',
    )
  })
})

describe('coalesceToolRuns', () => {
  const part = name => ({ type: 'tool_call', name })

  it('keeps two Reads as singles (fold needs ≥ 3)', () => {
    const runs = coalesceToolRuns([part(READ), part(READ)])
    assert.equal(runs.length, 2)
    assert.ok(runs.every(r => r.type === 'tool'))
  })

  it('folds three Reads into explored_run', () => {
    const runs = coalesceToolRuns([part(READ), part(READ), part(READ)])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].type, 'explored_run')
  })

  it('folds two Greps at N ≥ 2', () => {
    const runs = coalesceToolRuns([part(GREP), part(GREP)])
    assert.equal(runs[0].type, 'explored_run')
  })

  it('folds consecutive browser_* at N ≥ 2', () => {
    const runs = coalesceToolRuns([
      part('browser_navigate'),
      part('browser_click'),
    ])
    assert.equal(runs[0].type, 'browser_run')
  })

  it('keeps a lone browser_* as a single row', () => {
    const runs = coalesceToolRuns([part('browser_navigate')])
    assert.deepEqual(
      runs.map(r => r.type),
      ['tool'],
    )
  })

  it('folds explore + browser steps into one explored_run', () => {
    const runs = coalesceToolRuns([
      part(READ),
      part(GREP),
      part('browser_navigate'),
      part('browser_snapshot'),
      part('browser_click'),
    ])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].type, 'explored_run')
    assert.equal(runs[0].items.length, 5)
  })

  it('breaks the run at a non-groupable tool', () => {
    const runs = coalesceToolRuns([
      part('browser_navigate'),
      part(GREP),
      part('Bash'),
      part('browser_click'),
      part('browser_snapshot'),
    ])
    assert.deepEqual(
      runs.map(r => r.type),
      ['explored_run', 'tool', 'browser_run'],
    )
  })
})

describe('sanitizeToolUpdatePayload', () => {
  it('does not chop long bash output', () => {
    const log = 'ok\n'.repeat(300)
    const out = sanitizeToolUpdatePayload('Bash', { result: log })
    assert.equal(out.result, log)
  })

  it('strips legacy page snapshots from browser results', () => {
    const out = sanitizeToolUpdatePayload('browser_snapshot', {
      result: 'Loaded.\nCurrent page snapshot\n- heading [ref=e1]',
    })
    assert.equal(out.result, 'Loaded.')
  })
})

describe('formatWorkedDuration', () => {
  it('ceils sub-second work to 1s', () => {
    assert.equal(formatWorkedDuration(500), 'for 1s')
  })
})
