import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import { registerSessionLocation } from '../../core/session-paths.js'
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { definition } from './FileReadTool.js'

const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('FileRead of host tool-results from a cloud workspace', () => {
  it('reads the agent-host spill file instead of the container workspace', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-read-spill-'))
    cleanup.push(home)
    const filePath = path.join(
      home,
      getAppDirName(),
      'projects',
      'cloud-workspace',
      'session',
      'tool-results',
      'toolu_test.txt',
    )
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'full mcp output\n', 'utf8')

    let remoteReads = 0
    const execution = {
      kind: 'worker',
      environmentId: 'cloud:abc',
      resolve: (_cwd: string, requested: string) => requested,
      assertInWorkspace: () => {
        throw new Error('workspace boundary should not apply')
      },
      readText: async () => {
        remoteReads += 1
        return 'remote'
      },
    } as unknown as ExecutionBackend

    process.env.AUTH_ENABLED = 'true'
    const tool = definition.create('/workspace/repo', {
      eventBus: new EventBus(),
      wire: noopWireEmitter,
      execution,
    })
    const execute = tool.execute
    if (!execute) throw new Error('FileRead has no execute')
    const result = await runWithRequestScope(
      { agentHome: home, cwd: '/workspace/repo' },
      () =>
        execute(
          { file_path: filePath },
          { toolCallId: 'toolu_test', messages: [] },
        ),
    )

    expect(remoteReads).toBe(0)
    expect(JSON.stringify(result)).toContain('full mcp output')
  })
})

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

describe('FileRead of binary files in a cloud workspace', () => {
  function setup(
    files: Record<string, Buffer | string>,
    options: { withSession?: boolean } = {},
  ) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-read-remote-'))
    cleanup.push(home)
    const sessionId =
      options.withSession === false
        ? undefined
        : `remote-read-${Date.now()}-${Math.random()}`
    if (sessionId) {
      registerSessionLocation(sessionId, {
        projectKey: 'cloud',
        agentHome: home,
      })
    }
    const byteReads: string[] = []
    const execution = {
      kind: 'worker',
      environmentId: 'cloud:abc',
      resolve: (cwd: string, requested: string) =>
        path.posix.resolve(cwd, requested),
      assertInWorkspace: () => {},
      readText: async (abs: string) => {
        const file = files[abs]
        if (file === undefined) throw new Error('missing remote file')
        return Buffer.from(file).toString('utf8')
      },
      readBytes: async (abs: string) => {
        byteReads.push(abs)
        const file = files[abs]
        if (file === undefined) throw new Error('missing remote file')
        return Buffer.from(file)
      },
    } as unknown as ExecutionBackend
    const tool = definition.create('/workspace/repo', {
      eventBus: new EventBus(),
      wire: noopWireEmitter,
      execution,
      sessionId,
    })
    const execute = tool.execute
    if (!execute) throw new Error('FileRead has no execute')
    const read = (file_path: string) =>
      runWithRequestScope({ agentHome: home, cwd: '/workspace/repo' }, () =>
        execute({ file_path }, { toolCallId: 'toolu_test', messages: [] }),
      )
    return { home, read, byteReads }
  }

  it('fetches image bytes and attaches the image as a follow-up', async () => {
    const { read, byteReads } = setup({
      '/workspace/repo/out/chart.png': PNG_1X1,
    })

    const result = (await read('out/chart.png')) as {
      data: { type: string; file: { filePath: string } }
      newMessages?: Array<{ content: Array<{ type: string }> }>
    }

    expect(byteReads).toEqual(['/workspace/repo/out/chart.png'])
    expect(result.data.type).toBe('image')
    expect(result.data.file.filePath).toBe('out/chart.png')
    const parts = result.newMessages?.[0]?.content ?? []
    expect(parts.some(part => part.type === 'image')).toBe(true)
  })

  it('provides an environment preview when no session upload is available', async () => {
    const { read } = setup(
      { '/workspace/repo/scratch/render/montage.png': PNG_1X1 },
      { withSession: false },
    )

    const result = (await read(
      '/workspace/repo/scratch/render/montage.png',
    )) as {
      data: { type: string; file: { previewUrl?: string } }
    }

    expect(result.data.file.previewUrl).toBe(
      '/workspace/preview?environmentId=cloud%3Aabc&path=%2Fworkspace%2Frepo%2Fscratch%2Frender%2Fmontage.png',
    )
  })

  it('parses notebooks from fetched bytes', async () => {
    const notebook = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
    const { read } = setup({ '/workspace/repo/nb.ipynb': notebook })

    const result = (await read('nb.ipynb')) as {
      data: { type: string; file: { filePath: string } }
    }

    expect(result.data.type).toBe('notebook')
    expect(result.data.file.filePath).toBe('nb.ipynb')
  })

  it('refuses binary content behind a text extension', async () => {
    const { read, byteReads } = setup({
      '/workspace/repo/dump.dat': Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x14]),
    })

    const result = await read('dump.dat')

    expect(byteReads).toEqual([])
    expect(result).toBe('Error: binary file detected — cannot display dump.dat')
  })
})
