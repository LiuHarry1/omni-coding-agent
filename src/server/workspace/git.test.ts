import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShellFsPort, type ShellHost } from '../../execution/shell-fs.js'
import {
  gitDiff,
  gitDiffWith,
  gitStatus,
  gitStatusWith,
  normalizeGitRelativePath,
  shellGitHost,
} from './git.js'
import { containsGitMetadataPath } from './path-safety.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

/** The scripts a container or SSH host runs, against a local `sh`. */
const localShell: ShellHost = {
  spawn: script => spawn('sh', ['-c', script], { stdio: 'pipe' }),
}

describePosix('git Changes view through a shell host', () => {
  let root: string
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-host-')))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    fs.writeFileSync(path.join(root, 'keep.txt'), 'a\nb\nc\n')
    fs.writeFileSync(path.join(root, 'gone.txt'), 'bye\n')
    fs.writeFileSync(path.join(root, 'old-name.txt'), 'moving\n')
    git('add', '-A')
    git('commit', '-qm', 'init')

    fs.writeFileSync(path.join(root, 'keep.txt'), 'a\nB\nc\nd\n')
    fs.rmSync(path.join(root, 'gone.txt'))
    git('mv', 'old-name.txt', 'new name.txt')
    fs.writeFileSync(path.join(root, 'added.txt'), 'staged\n')
    git('add', 'added.txt')
    fs.mkdirSync(path.join(root, 'docs'))
    fs.writeFileSync(path.join(root, 'docs/说明.md'), '第一行\n第二行')
    fs.writeFileSync(path.join(root, 'img.bin'), Buffer.from([1, 0, 2, 3]))
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('matches the local status and every diff', async () => {
    const host = shellGitHost(new ShellFsPort(localShell), root)
    const local = await gitStatus(root)
    const remote = await gitStatusWith(host)
    expect(remote).toEqual(local)
    expect(local.branch).toBe('main')
    expect(local.entries.map(e => [e.path, e.status])).toEqual([
      ['added.txt', 'added'],
      ['docs/说明.md', 'untracked'],
      ['gone.txt', 'deleted'],
      ['img.bin', 'untracked'],
      ['keep.txt', 'modified'],
      ['new name.txt', 'renamed'],
    ])
    for (const e of local.entries) {
      expect(await gitDiffWith(host, e.path)).toEqual(
        await gitDiff(root, e.path),
      )
    }
  })

  it('reports a plain folder as not a repo', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'))
    try {
      const host = shellGitHost(new ShellFsPort(localShell), plain)
      expect((await gitStatusWith(host)).isGitRepo).toBe(false)
      const missing = shellGitHost(
        new ShellFsPort(localShell),
        path.join(plain, 'nope'),
      )
      expect((await gitStatusWith(missing)).isGitRepo).toBe(false)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })

  it('rejects absolute and parent-traversing diff paths', async () => {
    expect(() => normalizeGitRelativePath('../outside.txt')).toThrow(
      /inside the repository/,
    )
    expect(() => normalizeGitRelativePath('/etc/passwd')).toThrow(/relative/)
    expect(() => normalizeGitRelativePath('C:\\secret.txt')).toThrow(/relative/)
    await expect(gitDiff(root, '../outside.txt')).rejects.toThrow(
      /inside the repository/,
    )
  })

  it('does not follow a changed symlink outside the repository', async () => {
    const outside = path.join(path.dirname(root), 'outside-secret.txt')
    const link = path.join(root, 'outside-link.txt')
    fs.writeFileSync(outside, 'must-not-be-returned')
    fs.symlinkSync(outside, link)
    try {
      const diff = await gitDiff(root, 'outside-link.txt')
      expect(diff.newContent).toBe('')
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(outside, { force: true })
    }
  })

  it('disables a repository-configured fsmonitor command', async () => {
    const marker = path.join(root, 'fsmonitor-ran')
    const hook = path.join(root, 'fsmonitor.sh')
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`,
      { mode: 0o700 },
    )
    git('config', 'core.fsmonitor', hook)
    try {
      await gitStatus(root)
      await gitStatusWith(shellGitHost(new ShellFsPort(localShell), root))
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      git('config', '--unset', 'core.fsmonitor')
      fs.rmSync(marker, { force: true })
      fs.rmSync(hook, { force: true })
    }
  })

  it('recognizes Git metadata path segments portably', () => {
    expect(containsGitMetadataPath('.git/config')).toBe(true)
    expect(containsGitMetadataPath('/repo/.GIT/hooks/pre-commit')).toBe(true)
    expect(containsGitMetadataPath('src/git/config.ts')).toBe(false)
  })
})
