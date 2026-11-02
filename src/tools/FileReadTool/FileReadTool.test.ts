import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    const tool = definition.create('/workspace/repo', { execution })
    const result = await runWithRequestScope(
      { agentHome: home, cwd: '/workspace/repo' },
      () =>
        tool.execute(
          { file_path: filePath },
          { toolCallId: 'toolu_test', messages: [] },
        ),
    )

    expect(remoteReads).toBe(0)
    expect(JSON.stringify(result)).toContain('full mcp output')
  })
})
