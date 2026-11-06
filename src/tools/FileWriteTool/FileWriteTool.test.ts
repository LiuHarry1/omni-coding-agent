import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { createFilesystemPermissionContext } from '../../utils/permissions/filesystem.js'
import { definition } from './FileWriteTool.js'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function cloudExecution(writes: string[]): ExecutionBackend {
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
    exists: async () => false,
    isDirectory: async () => false,
    writeText: async (abs: string) => {
      writes.push(abs)
    },
  } as unknown as ExecutionBackend
}

async function runWrite(
  plansDir: string,
  writes: string[],
  args: { file_path: string; content: string },
): Promise<unknown> {
  const permissionContext = createFilesystemPermissionContext(
    '/workspace/repo',
    { extraWriteRoots: [plansDir] },
  )
  const tool = definition.create('/workspace/repo', {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    execution: cloudExecution(writes),
    permissionContext,
  })
  const execute = tool.execute
  if (!execute) throw new Error('Write has no execute')
  return execute(args as never, { toolCallId: 'toolu_write', messages: [] })
}

describe('Write of host plan files from a cloud workspace', () => {
  it('writes the plan file on the agent host instead of the container', async () => {
    const plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-plans-'))
    cleanup.push(plansDir)
    const planFile = path.join(plansDir, 'calm-otter.md')

    const writes: string[] = []
    const result = await runWrite(plansDir, writes, {
      file_path: planFile,
      content: '# Plan\n',
    })

    expect(writes).toEqual([])
    expect(fs.readFileSync(planFile, 'utf8')).toBe('# Plan\n')
    expect(JSON.stringify(result)).not.toContain('Error')
  })

  it('keeps workspace writes in the container', async () => {
    const plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-plans-'))
    cleanup.push(plansDir)

    const writes: string[] = []
    await runWrite(plansDir, writes, {
      file_path: 'notes.md',
      content: 'x',
    })

    expect(writes).toEqual(['/workspace/repo/notes.md'])
  })
})
