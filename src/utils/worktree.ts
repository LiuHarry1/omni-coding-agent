/**
 * Git worktrees for agents that run with `isolation: worktree`: each gets a
 * checkout of its own on a new branch, so agents working in parallel do not
 * edit the same files. A worktree the agent left unchanged is removed; one
 * with changes stays, for the caller to review and merge.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { resolveAgentHome } from './request-scope.js'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 << 20 })
  return stdout.trim()
}

export interface AgentWorktree {
  /** Where the checkout is. */
  path: string
  /** The agent's working directory: `path` plus where `cwd` sat in the repo. */
  cwd: string
  branch: string
  repoRoot: string
  baseCommit: string
}

export interface WorktreeOutcome {
  kept: boolean
  path: string
  branch: string
}

/** A worktree of the repo `cwd` is in, on branch `agent/<agentId>`. */
export async function createAgentWorktree(
  cwd: string,
  agentId: string,
): Promise<AgentWorktree> {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
    throw new Error(`invalid agent id for a worktree: ${agentId}`)
  }
  let repoRoot: string
  try {
    repoRoot = await git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new Error(`${cwd} is not in a git repository`)
  }
  const baseCommit = await git(repoRoot, ['rev-parse', 'HEAD'])
  const branch = `agent/${agentId}`
  const dir = path.join(
    resolveAgentHome(),
    'worktrees',
    `${path.basename(repoRoot)}-${agentId}`,
  )
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await git(repoRoot, ['worktree', 'add', '-b', branch, dir, baseCommit])
  const rel = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(cwd))
  return {
    path: dir,
    cwd: rel && !rel.startsWith('..') ? path.join(dir, rel) : dir,
    branch,
    repoRoot,
    baseCommit,
  }
}

/** Remove the worktree and its branch when the agent changed nothing. */
export async function finishAgentWorktree(
  worktree: AgentWorktree,
): Promise<WorktreeOutcome> {
  const outcome = { path: worktree.path, branch: worktree.branch }
  try {
    const dirty = await git(worktree.path, ['status', '--porcelain'])
    const head = await git(worktree.path, ['rev-parse', 'HEAD'])
    if (dirty || head !== worktree.baseCommit) return { ...outcome, kept: true }
    await git(worktree.repoRoot, [
      'worktree',
      'remove',
      '--force',
      worktree.path,
    ])
    await git(worktree.repoRoot, ['branch', '-D', worktree.branch])
    return { ...outcome, kept: false }
  } catch (err) {
    console.warn(
      `[worktree] could not tidy ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ...outcome, kept: true }
  }
}

export function worktreeOutcomeText(outcome: WorktreeOutcome): string {
  return outcome.kept
    ? `The agent worked in a git worktree; its changes are in ${outcome.path} on branch ${outcome.branch}.`
    : ''
}
