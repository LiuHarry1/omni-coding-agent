import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWithRequestScope } from './request-scope.js'
import { createAgentWorktree, finishAgentWorktree } from './worktree.js'

let repo: string
let agentHome: string

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

function scoped<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestScope({ agentHome, cwd: repo }, fn)
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-')))
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-home-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(agentHome, { recursive: true, force: true })
})

describe('agent worktrees', () => {
  it('starts where cwd sits in the repo and goes away when unchanged', async () => {
    const wt = await scoped(() =>
      createAgentWorktree(path.join(repo, 'src'), 'agent1'),
    )
    expect(wt.cwd).toBe(path.join(wt.path, 'src'))
    expect(fs.readFileSync(path.join(wt.cwd, 'a.txt'), 'utf8')).toBe(
      'original\n',
    )
    expect(await finishAgentWorktree(wt)).toMatchObject({ kept: false })
    expect(fs.existsSync(wt.path)).toBe(false)
    expect(git('branch', '--list', 'agent/agent1')).toBe('')
  })

  it('keeps two agents editing the same file apart', async () => {
    const [one, two] = await scoped(() =>
      Promise.all([
        createAgentWorktree(repo, 'one'),
        createAgentWorktree(repo, 'two'),
      ]),
    )
    fs.writeFileSync(path.join(one.cwd, 'src', 'a.txt'), 'one\n')
    fs.writeFileSync(path.join(two.cwd, 'src', 'a.txt'), 'two\n')

    expect(fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8')).toBe(
      'original\n',
    )
    expect(await finishAgentWorktree(one)).toEqual({
      kept: true,
      path: one.path,
      branch: 'agent/one',
    })
    expect(await finishAgentWorktree(two)).toMatchObject({ kept: true })
    expect(fs.readFileSync(path.join(one.cwd, 'src', 'a.txt'), 'utf8')).toBe(
      'one\n',
    )
    expect(fs.readFileSync(path.join(two.cwd, 'src', 'a.txt'), 'utf8')).toBe(
      'two\n',
    )
  })

  it('refuses a directory outside git', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plain-'))
    await expect(scoped(() => createAgentWorktree(plain, 'x'))).rejects.toThrow(
      /not in a git repository/,
    )
    fs.rmSync(plain, { recursive: true, force: true })
  })
})
