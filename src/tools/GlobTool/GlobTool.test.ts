import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { definition } from './GlobTool.js'

const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function runGlobTool(
  home: string,
  args: { pattern: string; path?: string },
): Promise<{ result: unknown; remoteCalls: number }> {
  let remoteCalls = 0
  const execution = {
    kind: 'worker',
    environmentId: 'cloud:abc',
    resolve: (_cwd: string, requested: string) => requested,
    assertInWorkspace: () => {
      throw new Error('workspace boundary should not apply')
    },
    isDirectory: async () => {
      remoteCalls += 1
      return false
    },
    rg: async () => {
      remoteCalls += 1
      return []
    },
  } as unknown as ExecutionBackend

  process.env.AUTH_ENABLED = 'true'
  const tool = definition.create('/workspace/repo', {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    execution,
  })
  const execute = tool.execute
  if (!execute) throw new Error('Glob has no execute')
  const result = await runWithRequestScope(
    { agentHome: home, cwd: '/workspace/repo' },
    () => execute(args, { toolCallId: 'toolu_glob', messages: [] }),
  )
  return { result, remoteCalls }
}

function makeSpillDir(): { home: string; dir: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-glob-spill-'))
  cleanup.push(home)
  const dir = path.join(
    home,
    getAppDirName(),
    'projects',
    'cloud-workspace',
    'session',
    'tool-results',
  )
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'toolu_test.txt')
  fs.writeFileSync(file, 'full mcp output\n', 'utf8')
  return { home, dir, file }
}

describe('Glob of host tool-results from a cloud workspace', () => {
  it('lists the agent-host spill dir given as path', async () => {
    const { home, dir, file } = makeSpillDir()
    const { result, remoteCalls } = await runGlobTool(home, {
      pattern: '*.txt',
      path: dir,
    })
    expect(remoteCalls).toBe(0)
    expect(JSON.stringify(result)).toContain(file.replaceAll('\\', '/'))
  })

  it('lists the agent-host spill dir given as the pattern', async () => {
    const { home, dir, file } = makeSpillDir()
    const { result, remoteCalls } = await runGlobTool(home, { pattern: dir })
    expect(remoteCalls).toBe(0)
    expect(JSON.stringify(result)).toContain(file.replaceAll('\\', '/'))
  })

  it('lists the agent-host spill dir given as an absolute glob', async () => {
    const { home, dir, file } = makeSpillDir()
    const { result, remoteCalls } = await runGlobTool(home, {
      pattern: path.join(dir, '*.txt'),
    })
    expect(remoteCalls).toBe(0)
    expect(JSON.stringify(result)).toContain(file.replaceAll('\\', '/'))
  })

  it('lists agent-host spill files through a recursive absolute glob', async () => {
    const { home, file } = makeSpillDir()
    const projects = path.join(home, getAppDirName(), 'projects')
    const { result, remoteCalls } = await runGlobTool(home, {
      pattern: path.join(projects, '**', 'tool-results', '*.txt'),
    })
    expect(remoteCalls).toBe(0)
    expect(JSON.stringify(result)).toContain(file.replaceAll('\\', '/'))
  })

  it('keeps absolute globs outside the harness dirs on the remote', async () => {
    const { home } = makeSpillDir()
    const { result } = await runGlobTool(home, {
      pattern: path.join(home, 'other', '*.txt'),
    })
    // The stub's workspace check throws, so reaching it proves remote routing.
    expect(String(result)).toContain('workspace boundary should not apply')
  })
})
