import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { definition } from './GrepTool.js'

const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function cloudExecution(calls: { rg: number }): ExecutionBackend {
  return {
    kind: 'worker',
    environmentId: 'cloud:abc',
    resolve: (cwd: string, requested: string) =>
      requested.startsWith('/') ? requested : `${cwd}/${requested}`,
    assertInWorkspace: (cwd: string, abs: string) => {
      if (!abs.startsWith(cwd)) {
        throw new Error(`Refused: "${abs}" is outside the workspace "${cwd}".`)
      }
    },
    rg: async () => {
      calls.rg += 1
      return []
    },
  } as unknown as ExecutionBackend
}

async function runGrep(
  home: string,
  execution: ExecutionBackend,
  args: Record<string, unknown>,
): Promise<unknown> {
  process.env.AUTH_ENABLED = 'true'
  const tool = definition.create('/workspace/repo', {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    execution,
  })
  const execute = tool.execute
  if (!execute) throw new Error('Grep has no execute')
  return runWithRequestScope({ agentHome: home, cwd: '/workspace/repo' }, () =>
    execute(args as never, { toolCallId: 'toolu_grep', messages: [] }),
  )
}

describe('Grep of host tool-results from a cloud workspace', () => {
  it('searches the agent-host spill file instead of the container', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-grep-spill-'))
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
    fs.writeFileSync(
      filePath,
      'intro\nRecipe state UNDEFINED after abort\noutro\n',
      'utf8',
    )

    const calls = { rg: 0 }
    const result = await runGrep(home, cloudExecution(calls), {
      pattern: 'UNDEFINED',
      path: filePath,
      output_mode: 'content',
    })

    expect(calls.rg).toBe(0)
    const text = JSON.stringify(result)
    expect(text).toContain('Recipe state UNDEFINED after abort')
    expect(text).toContain('toolu_test.txt')
  })

  it('reports host matches by absolute path when searching the spill dir', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-grep-dir-'))
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
    const filePath = path.join(dir, 'toolu_test.txt')
    fs.writeFileSync(filePath, 'Recipe state UNDEFINED\n', 'utf8')

    const calls = { rg: 0 }
    const result = await runGrep(home, cloudExecution(calls), {
      pattern: 'UNDEFINED',
      path: dir,
    })

    expect(calls.rg).toBe(0)
    expect(JSON.stringify(result)).toContain(filePath.replaceAll('\\', '/'))
  })

  it('still refuses host paths outside the workspace and harness dirs', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-grep-deny-'))
    cleanup.push(home)

    const calls = { rg: 0 }
    const result = await runGrep(home, cloudExecution(calls), {
      pattern: 'root',
      path: '/etc',
    })

    expect(calls.rg).toBe(0)
    expect(String(result)).toMatch(/outside the workspace/)
  })
})
