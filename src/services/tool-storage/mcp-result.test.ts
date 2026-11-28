import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSessionLocation } from '../../session/paths.js'
import { _setCronStorePathForTest } from '../cron/store.js'
import { deleteSession, forgetSession } from '../../session/index.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import { buildToolMessage, executeOneTool } from '../tools/tool_execution.js'
import {
  getPersistThresholdChars,
  isToolResultsHostOnly,
  maybePersistAfterExecute,
  setToolResultsHostOnly,
} from './index.js'
import { processMcpToolResult, type McpCallResult } from './mcp-result.js'

const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
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

function run(
  sessionId: string,
  raw: McpCallResult,
  toolName = 'tdc-docs_tdc_retrieve',
) {
  return processMcpToolResult(raw, {
    sessionId,
    toolCallId: `toolu_${sessionId}`,
    toolName,
  })
}

function savedPath(result: string): string {
  const m = /saved to:? (\S+?)(?:\.\n|\n|$)/.exec(result)
  if (!m) throw new Error(`no saved path in: ${result.slice(0, 300)}`)
  return m[1]!
}

/** 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const png = { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }
const pngBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
}

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: '#336699' },
  })
}

describe('local MCP results follow Claude Code', () => {
  it('keeps a result under 50K chars inline as structuredContent JSON', async () => {
    await inScope(async () => {
      const raw = tdcResult(15, 2_000)
      const out = await run('local-inline', raw)
      expect(out.result).toBe(JSON.stringify(raw.structuredContent))
      expect(out.blocks).toBeUndefined()
    })
  })

  it('persists a result over 50K chars with a plain preview', async () => {
    await inScope(async () => {
      const out = await run('local-50k', tdcResult(30, 2_000))
      expect(out.result).toContain('Output too large (')
      expect(out.result).toContain('Preview (first 2KB):')
      expect(out.result).not.toContain('jq')
      expect(fs.existsSync(savedPath(out.result))).toBe(true)
    })
  })

  it('persists a result over the MCP token cap with jq instructions', async () => {
    await inScope(async () => {
      const out = await run('local-tokens', tdcResult(60, 2_000))
      expect(out.result).toMatch(/^Error: result \([\d,]+ characters\)/)
      expect(out.result).toContain(
        'Format: JSON with schema: {rag_version: string, chunks: [{...}]}',
      )
      expect(out.result).toContain('jq to make structured queries')
    })
  })
})

describe('MCP error results keep their message', () => {
  it('puts the error text before a code-only structuredContent', async () => {
    await inScope(async () => {
      const out = await run('local-inline', {
        content: [{ type: 'text', text: 'set_value: no ValuePattern' }],
        structuredContent: { code: 'tool_invocation_failed' },
        isError: true,
      })
      expect(out.isError).toBe(true)
      expect(out.result).toBe(
        'set_value: no ValuePattern\n{"code":"tool_invocation_failed"}',
      )
    })
  })

  it('does not repeat structuredContent the text already mirrors', async () => {
    await inScope(async () => {
      const error = { code: 'not_found', message: 'no such window' }
      const out = await run('local-inline', {
        content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
        structuredContent: error,
        isError: true,
      })
      expect(out.result).toBe(JSON.stringify(error, null, 2))
    })
  })

  it('sends text only, even when the error carries an image', async () => {
    await inScope(async () => {
      const out = await run('local-inline', {
        content: [{ type: 'text', text: 'click failed' }, png],
        isError: true,
      })
      expect(out).toEqual({ result: 'click failed', isError: true })
    })
  })

  it('says so when the error has no message', async () => {
    await inScope(async () => {
      const out = await run('local-inline', { content: [], isError: true })
      expect(out.result).toBe('Unknown error')
    })
  })
})

describe('MCP image results reach the model', () => {
  it('keeps images next to structuredContent', async () => {
    await inScope(async () => {
      const out = await run('local-inline', {
        content: [png, { type: 'text', text: 'Captured 1600x900' }],
        structuredContent: { capture_id: 'c1', screenshot_width: 1600 },
      })
      expect(out.blocks).toEqual([
        { type: 'text', text: '{"capture_id":"c1","screenshot_width":1600}' },
        pngBlock,
      ])
      expect(out.result).toBe(
        '{"capture_id":"c1","screenshot_width":1600}\n[image]',
      )
    })
  })

  it('keeps captions next to their images without structuredContent', async () => {
    await inScope(async () => {
      const out = await run('local-inline', {
        content: [
          { type: 'text', text: 'before' },
          png,
          { type: 'text', text: 'after' },
          png,
        ],
      })
      expect(out.blocks?.map(b => b.type)).toEqual([
        'text',
        'image',
        'text',
        'image',
      ])
      expect(out.result).toBe('before\n[image]\nafter\n[image]')
    })
  })

  it('shrinks an image over the API limits', async () => {
    await inScope(async () => {
      const wide = await solid(2600, 100).png().toBuffer()
      const out = await run('local-inline', {
        content: [
          {
            type: 'image',
            data: wide.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      })
      const [block] = out.blocks!
      if (block?.type !== 'image') throw new Error('expected an image block')
      const meta = await sharp(
        Buffer.from(block.source.data, 'base64'),
      ).metadata()
      expect(meta.width).toBe(2000)
    })
  })

  it('labels an image by its bytes, not by the type the server claimed', async () => {
    await inScope(async () => {
      const jpeg = await solid(40, 40).jpeg().toBuffer()
      const out = await run('local-inline', {
        content: [
          {
            type: 'image',
            data: jpeg.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      })
      expect(out.blocks).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: jpeg.toString('base64'),
          },
        },
      ])
    })
  })

  it('persists text that is too large and keeps the image inline', async () => {
    await inScope(async () => {
      const raw = tdcResult(30, 2_000)
      const out = await run('local-50k', {
        content: [...raw.content, png],
        structuredContent: raw.structuredContent,
      })
      expect(out.blocks).toHaveLength(2)
      const [text, image] = out.blocks!
      expect(text).toMatchObject({ type: 'text' })
      expect(out.result).toContain('Output too large (')
      expect(image).toEqual(pngBlock)
    })
  })

  it('reaches the model as content output through executeOneTool', async () => {
    await inScope(async () => {
      const executed = await executeOneTool(
        { toolCallId: 'toolu_shot', toolName: 'shot', input: {} },
        {
          shot: {
            execute: async () => ({
              content: [{ type: 'text', text: 'done' }, png],
            }),
          },
        } as never,
        { toolResult: () => {} } as never,
        'local-inline',
      )
      expect(executed.result).toBe('done\n[image]')
      expect(buildToolMessage([executed]).content[0]!.output).toEqual({
        type: 'content',
        value: [
          { type: 'text', text: 'done' },
          { type: 'image-data', data: PNG_BASE64, mediaType: 'image/png' },
        ],
      })
    })
  })
})

describe('MCP image results over the token cap follow Claude Code', () => {
  const NOTICE = '[OUTPUT TRUNCATED - exceeded'

  it('compresses an image into what is left of the budget', async () => {
    // 8000 chars: 6400 for the first image, 1600 left for the second.
    vi.stubEnv('MAX_MCP_OUTPUT_TOKENS', '2000')
    await inScope(async () => {
      const large = await solid(800, 600).jpeg().toBuffer()
      expect(large.length).toBeGreaterThan(1200)
      const out = await run('local-inline', {
        content: [
          png,
          {
            type: 'image',
            data: large.toString('base64'),
            mimeType: 'image/jpeg',
          },
        ],
      })
      const [first, second, notice] = out.blocks!
      expect(first).toEqual(pngBlock)
      if (second?.type !== 'image') throw new Error('expected an image block')
      expect(second.source.data.length).toBeLessThanOrEqual(1600)
      const meta = await sharp(
        Buffer.from(second.source.data, 'base64'),
      ).metadata()
      expect(meta.width).toBeLessThan(800)
      expect(notice).toMatchObject({ type: 'text' })
      expect(out.result).toContain(`${NOTICE} 2000 token limit]`)
    })
  })

  it('drops an image once the budget is spent', async () => {
    vi.stubEnv('MAX_MCP_OUTPUT_TOKENS', '1600')
    await inScope(async () => {
      const out = await run('local-inline', { content: [png, png] })
      expect(out.blocks).toHaveLength(2)
      expect(out.blocks![0]).toEqual(pngBlock)
      expect(out.result).toMatch(/^\[image\]\n\n\n\[OUTPUT TRUNCATED/)
    })
  })

  it('returns text only when no image is left', async () => {
    vi.stubEnv('MAX_MCP_OUTPUT_TOKENS', '10')
    await inScope(async () => {
      const out = await run('local-inline', {
        content: [{ type: 'text', text: 'caption' }, png],
      })
      expect(out.blocks).toBeUndefined()
      expect(out.result).toMatch(/^caption\n\n\n\[OUTPUT TRUNCATED/)
    })
  })

  it('leaves a result under the cap alone', async () => {
    await inScope(async () => {
      const out = await run('local-inline', {
        content: Array.from({ length: 15 }, () => png),
      })
      expect(out.blocks).toHaveLength(15)
      expect(out.result).not.toContain(NOTICE)
    })
  })
})

describe('MCP binary content is saved, never inlined as base64', () => {
  it('saves audio and returns its path', async () => {
    await inScope(async () => {
      const bytes = Buffer.from('RIFF....WAVEfmt ')
      const out = await run(
        'local-inline',
        {
          content: [
            {
              type: 'audio',
              data: bytes.toString('base64'),
              mimeType: 'audio/wav',
            },
          ],
        },
        'tts_speak',
      )
      expect(out.blocks).toBeUndefined()
      expect(out.result).not.toContain(bytes.toString('base64'))
      expect(out.result).toMatch(
        /^\[Audio from tts_speak\] Binary content \(audio\/wav, 16 bytes\) saved to .*toolu_local-inline-0\.wav$/,
      )
      expect(fs.readFileSync(savedPath(out.result))).toEqual(bytes)
    })
  })

  it('saves an image the codec cannot open instead of sending it', async () => {
    await inScope(async () => {
      // A PNG signature with nothing after it.
      const out = await run('local-inline', {
        content: [
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      })
      expect(out.blocks).toBeUndefined()
      expect(out.result).toMatch(
        /^Binary content \(image\/png, 8 bytes\) saved to .*\.png$/,
      )
    })
  })

  it('shows an image resource as an image', async () => {
    await inScope(async () => {
      const out = await run(
        'local-inline',
        {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'shot://1',
                blob: PNG_BASE64,
                mimeType: 'image/png',
              },
            },
          ],
        },
        'grab',
      )
      expect(out.blocks).toEqual([
        { type: 'text', text: '[Resource from grab at shot://1]' },
        pngBlock,
      ])
    })
  })
})

describe('host-only MCP results are rendered for Read and Grep', () => {
  it('expands nested JSON and restores newlines in the spill file', async () => {
    await inScope(async () => {
      setToolResultsHostOnly('cloud', true)
      try {
        const out = await run('cloud', tdcResult(20, 2_000))
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
