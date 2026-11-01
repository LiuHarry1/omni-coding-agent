import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expandInlineDirectives,
  type DirectiveRuntime,
} from './promptExpansion.js'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

function mockRuntime(): DirectiveRuntime {
  return {
    exec: vi.fn(async () => ({
      stdout: 'from-container\n',
      stderr: '',
      code: 0,
    })),
    resolve: vi.fn((cwd: string, filePath: string) =>
      path.posix.resolve(cwd, filePath),
    ),
    assertInWorkspace: vi.fn(),
    readText: vi.fn(async () => 'remote file'),
  }
}

describe('prompt directive runtime', () => {
  it('runs commands and reads files through the injected backend', async () => {
    const runtime = mockRuntime()
    const expanded = await expandInlineDirectives(
      'Command: !`pwd`\nFile: @notes.md',
      '/workspace/repo',
      runtime,
    )

    expect(runtime.exec).toHaveBeenCalledWith('pwd', {
      cwd: '/workspace/repo',
      timeoutMs: 15_000,
    })
    expect(runtime.resolve).toHaveBeenCalledWith('/workspace/repo', 'notes.md')
    expect(runtime.assertInWorkspace).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/repo/notes.md',
      'read',
    )
    expect(runtime.readText).toHaveBeenCalledWith('/workspace/repo/notes.md')
    expect(expanded).toContain('Command: from-container')
    expect(expanded).toContain('remote file')
  })

  it('fails closed on backend errors without executing on the host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directive-closed-'))
    temporaryPaths.push(dir)
    const marker = path.join(dir, 'host-marker')
    const runtime = mockRuntime()
    vi.mocked(runtime.exec).mockRejectedValue(new Error('worker unavailable'))

    const expanded = await expandInlineDirectives(
      `! \`not-a-directive\` !\`touch ${marker}\``,
      '/workspace/repo',
      runtime,
    )

    expect(expanded).toContain(
      `[error: !\`touch ${marker}\` failed: worker unavailable]`,
    )
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('enforces backend workspace containment for file directives', async () => {
    const runtime = mockRuntime()
    vi.mocked(runtime.assertInWorkspace).mockImplementation(() => {
      throw new Error('outside workspace')
    })

    const expanded = await expandInlineDirectives(
      'Read @../secret.txt',
      '/workspace/repo',
      runtime,
    )

    expect(expanded).toContain(
      '[error: @../secret.txt could not be read: outside workspace]',
    )
    expect(runtime.readText).not.toHaveBeenCalled()
  })

  it('preserves desktop host execution and file reads without a runtime', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directive-local-'))
    temporaryPaths.push(dir)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'desktop file')

    const expanded = await expandInlineDirectives(
      'Command !`printf desktop-command` and @notes.txt',
      dir,
    )

    expect(expanded).toContain('desktop-command')
    expect(expanded).toContain('desktop file')
  })
})
