import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ShellFsPort } from '../../execution/shell-fs.js'
import {
  assertSafeEnvironmentDelete,
  searchEnvironmentFiles,
} from './environment-fs.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('environment filesystem delete guard', () => {
  let workspace: string
  let port: ShellFsPort

  beforeEach(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'environment-fs-')),
    )
    port = new ShellFsPort({
      spawn: script => spawn('sh', ['-c', script], { stdio: 'pipe' }),
    })
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it.each(['', ' ', '/', '~', '$HOME'])(
    'rejects protected delete target %j',
    async target => {
      await expect(
        assertSafeEnvironmentDelete(port, target, workspace),
      ).rejects.toMatchObject({ status: 400, code: 'EINVAL' })
    },
  )

  it('rejects the workspace root but allows a child path', async () => {
    const child = path.join(workspace, 'child')
    fs.mkdirSync(child)

    await expect(
      assertSafeEnvironmentDelete(port, workspace, workspace),
    ).rejects.toMatchObject({ status: 400, code: 'EINVAL' })
    await expect(
      assertSafeEnvironmentDelete(port, child, workspace),
    ).resolves.toBeUndefined()
  })

  it('searches remote-style workspaces without indexing hidden or dependency trees', async () => {
    fs.mkdirSync(path.join(workspace, 'src'))
    fs.writeFileSync(path.join(workspace, 'src', 'apple.ts'), '')
    fs.mkdirSync(path.join(workspace, 'node_modules'))
    fs.writeFileSync(path.join(workspace, 'node_modules', 'apple.js'), '')
    fs.mkdirSync(path.join(workspace, '.hidden'))
    fs.writeFileSync(path.join(workspace, '.hidden', 'apple.txt'), '')
    fs.mkdirSync(path.join(workspace, '.ai-agent'))
    fs.writeFileSync(path.join(workspace, '.ai-agent', 'apple.md'), '')

    const result = await searchEnvironmentFiles(
      port,
      workspace,
      'apple',
      15,
      false,
    )

    expect(result.entries).toEqual([
      { path: 'src/apple.ts', isDir: false },
      { path: '.ai-agent/apple.md', isDir: false },
    ])
    expect(
      (await searchEnvironmentFiles(port, workspace, 'apple', 15, true))
        .entries,
    ).toContainEqual({ path: '.hidden/apple.txt', isDir: false })
  })
})
