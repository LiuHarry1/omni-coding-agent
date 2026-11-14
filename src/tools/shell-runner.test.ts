import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../core/types.js'
import { createFilesystemPermissionContext } from '../utils/permissions/filesystem.js'
import { definition as bash } from './BashTool/BashTool.js'

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-tool-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

type Execute = (
  args: { command: string },
  options: { toolCallId: string },
) => Promise<unknown>

function bashTool(rules: { deny?: string[] }) {
  const context = {
    permissionContext: createFilesystemPermissionContext(root, {
      mode: 'default',
      ...rules,
    }),
  } as ToolContext
  const tool = bash.create(root, context) as unknown as { execute: Execute }
  return (command: string) => tool.execute({ command }, { toolCallId: 'c1' })
}

describe('shell tool', () => {
  it('refuses a denied command even when no permission gate ran first', async () => {
    const run = bashTool({ deny: ['Bash(touch:*)'] })

    const result = await run('touch marker.txt')

    expect(result).toBe(
      'Error: Permission to use Bash with command touch marker.txt has been denied.',
    )
    expect(fs.existsSync(path.join(root, 'marker.txt'))).toBe(false)
  })

  it('runs a command no deny rule covers', async () => {
    const run = bashTool({ deny: ['Bash(rm:*)'] })

    await run('touch marker.txt')

    expect(fs.existsSync(path.join(root, 'marker.txt'))).toBe(true)
  })

  it('reports which inputs only read', () => {
    expect(bash.isReadOnly?.({ command: 'git status' })).toBe(true)
    expect(bash.isReadOnly?.({ command: 'npm test' })).toBe(false)
    expect(bash.isReadOnly?.(undefined)).toBe(false)
  })

  it('runs read-only commands side by side unless they change directory', () => {
    expect(bash.isConcurrencySafe?.({ command: 'ls src | wc -l' })).toBe(true)
    expect(bash.isConcurrencySafe?.({ command: 'cd src && ls' })).toBe(false)
    expect(bash.isConcurrencySafe?.({ command: 'npm test' })).toBe(false)
    expect(
      bash.isConcurrencySafe?.({ command: 'ls', run_in_background: true }),
    ).toBe(false)
  })
})
