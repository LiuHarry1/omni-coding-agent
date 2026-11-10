import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _clearGitRootCacheForTest,
  findCanonicalGitRoot,
  findGitRoot,
} from './git-root.js'

let root = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd, stdio: 'ignore' },
  )
}

function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

beforeEach(() => {
  // git writes realpaths into worktree metadata; keep expectations comparable.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-root-')))
  _clearGitRootCacheForTest()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findCanonicalGitRoot', () => {
  it('finds the repo root from a nested directory', () => {
    const repo = initRepo(path.join(root, 'repo'))
    const nested = path.join(repo, 'packages', 'web')
    fs.mkdirSync(nested, { recursive: true })

    expect(findGitRoot(nested)).toBe(repo)
    expect(findCanonicalGitRoot(nested)).toBe(repo)
  })

  it('returns null outside a repository', () => {
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)

    expect(findCanonicalGitRoot(plain)).toBeNull()
  })

  it('maps a worktree to its main repository', () => {
    const repo = initRepo(path.join(root, 'repo'))
    const worktree = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', worktree)

    expect(findGitRoot(worktree)).toBe(worktree)
    expect(findCanonicalGitRoot(worktree)).toBe(repo)
  })

  it('rejects a checkout that borrows another repo through commondir', () => {
    const victim = initRepo(path.join(root, 'victim'))
    const evil = path.join(root, 'evil')
    const fakeGitDir = path.join(evil, 'meta')
    fs.mkdirSync(fakeGitDir, { recursive: true })
    fs.writeFileSync(path.join(evil, '.git'), `gitdir: ${fakeGitDir}\n`)
    fs.writeFileSync(
      path.join(fakeGitDir, 'commondir'),
      path.join(victim, '.git'),
    )
    fs.writeFileSync(path.join(fakeGitDir, 'gitdir'), path.join(evil, '.git'))

    expect(findCanonicalGitRoot(evil)).toBe(evil)
  })

  it('rejects a checkout that reuses an existing worktree entry', () => {
    const repo = initRepo(path.join(root, 'repo'))
    git(repo, 'worktree', 'add', '-q', path.join(root, 'wt'))
    const evil = path.join(root, 'evil')
    fs.mkdirSync(evil)
    fs.writeFileSync(
      path.join(evil, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`,
    )

    expect(findCanonicalGitRoot(evil)).toBe(evil)
  })
})
