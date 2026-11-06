import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerSessionLocation } from '../../core/session-paths.js'
import { _setCronStorePathForTest } from '../cron/store.js'
import { deleteSession, forgetSession } from '../../session/index.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  getPersistThresholdChars,
  isToolResultsHostOnly,
  maybePersistAfterExecute,
  setToolResultsHostOnly,
} from './index.js'
import { processMcpToolResult } from './mcp-result.js'

const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const SESSIONS = ['local-inline', 'local-50k', 'local-tokens', 'cloud']

function inScope<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-mcp-result-'))
  cleanup.push(home)
  process.env.AUTH_ENABLED = 'true'
  for (const id of SESSIONS) {
    registerSessionLocation(id, { projectKey: 'mcp-test', agentHome: home })
  }
  return runWithRequestScope({ agentHome: home, cwd: home }, fn)
}

/** TDC-shaped result: minified JSON whose chunk bodies are multi-line. */
function tdcResult(chunks: number, bodyChars: number) {
  const data = {
    rag_version: 'v1.6.1',
    chunks: Array.from({ length: chunks }, (_, i) => ({
      bc: `SmarTest 8 > Recipe ${i}`,
      content: `Recipe state transition ${i}\n\nUNDEFINED -> EXECUTING\n${'x'.repeat(bodyChars)}`,
    })),
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  }
}

function run(sessionId: string, raw: ReturnType<typeof tdcResult>) {
  return processMcpToolResult(raw, {
    sessionId,
    toolCallId: `toolu_${sessionId}`,
    toolName: 'tdc-docs_tdc_retrieve',
  })!
}

function savedPath(result: string): string {
  const m = /saved to:? (\S+?)(?:\.\n|\n)/.exec(result)
  if (!m) throw new Error(`no saved path in: ${result.slice(0, 300)}`)
  return m[1]!
}

describe('local MCP results follow Claude Code', () => {
  it('keeps a result under 50K chars inline as structuredContent JSON', () => {
    inScope(() => {
      const raw = tdcResult(15, 2_000)
      const out = run('local-inline', raw)
      expect(out.result).toBe(JSON.stringify(raw.structuredContent))
    })
  })

  it('persists a result over 50K chars with a plain preview', () => {
    inScope(() => {
      const out = run('local-50k', tdcResult(30, 2_000))
      expect(out.result).toContain('Output too large (')
      expect(out.result).toContain('Preview (first 2KB):')
      expect(out.result).not.toContain('jq')
      expect(fs.existsSync(savedPath(out.result))).toBe(true)
    })
  })

  it('persists a result over the MCP token cap with jq instructions', () => {
    inScope(() => {
      const out = run('local-tokens', tdcResult(60, 2_000))
      expect(out.result).toMatch(/^Error: result \([\d,]+ characters\)/)
      expect(out.result).toContain(
        'Format: JSON with schema: {rag_version: string, chunks: [{...}]}',
      )
      expect(out.result).toContain('jq to make structured queries')
    })
  })
})

describe('host-only MCP results are rendered for Read and Grep', () => {
  it('expands nested JSON and restores newlines in the spill file', () => {
    inScope(() => {
      setToolResultsHostOnly('cloud', true)
      try {
        const out = run('cloud', tdcResult(20, 2_000))
        expect(out.result).toContain('shell commands cannot reach it')
        const saved = fs.readFileSync(savedPath(out.result), 'utf8')
        expect(saved).toContain('rag_version: v1.6.1')
        expect(saved).toMatch(/^ {6}UNDEFINED -> EXECUTING$/m)
        const longest = Math.max(...saved.split('\n').map(l => l.length))
        expect(longest).toBeLessThan(2_100)
      } finally {
        setToolResultsHostOnly('cloud', false)
      }
    })
  })
})

describe('host-only flag lifetime', () => {
  it('is dropped when the session is deleted or forgotten', () => {
    // deleteSession prunes the process-wide cron store; keep it off real disk.
    const cronDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-mcp-cron-'))
    cleanup.push(cronDir)
    _setCronStorePathForTest(path.join(cronDir, 'scheduled_tasks.json'))
    try {
      inScope(() => {
        setToolResultsHostOnly('cloud', true)
        deleteSession('cloud')
        expect(isToolResultsHostOnly('cloud')).toBe(false)

        setToolResultsHostOnly('local-inline', true)
        forgetSession('local-inline')
        expect(isToolResultsHostOnly('local-inline')).toBe(false)
      })
    } finally {
      _setCronStorePathForTest(null)
      setToolResultsHostOnly('cloud', false)
      setToolResultsHostOnly('local-inline', false)
    }
  })
})

describe('Read output is never persisted', () => {
  it('passes large Read results through', () => {
    expect(getPersistThresholdChars('Read')).toBe(Infinity)
    const big = 'line\n'.repeat(20_000)
    expect(maybePersistAfterExecute('s', 'toolu_r', 'Read', big)).toBe(big)
  })
})
