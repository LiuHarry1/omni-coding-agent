/**
 * Main-repo working tree root (worktrees share the main repo identity).
 * Falls back to null when not a git checkout.
 *
 * Mirrors Claude Code `utils/git.ts`: walk up with stat calls instead of
 * spawning git, and memoize both steps with a small LRU because this runs on
 * hot paths (memory roots, prompt building).
 */
import * as fs from 'fs'
import * as path from 'path'
import { LRUCache } from 'lru-cache'

const NOT_FOUND = Symbol('git-root-not-found')
const CACHE_SIZE = 50

const gitRootCache = new LRUCache<string, string | typeof NOT_FOUND>({
  max: CACHE_SIZE,
})
const canonicalRootCache = new LRUCache<string, string>({ max: CACHE_SIZE })

function hasGitEntry(dir: string): boolean {
  try {
    const stat = fs.statSync(path.join(dir, '.git'))
    // A directory for regular repos; a file for worktrees and submodules.
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

/** Directory containing `.git`, or null when `startPath` is not in a repo. */
export function findGitRoot(startPath: string): string | null {
  const start = path.resolve(startPath)
  let cached = gitRootCache.get(start)
  if (cached === undefined) {
    cached = NOT_FOUND
    let current = start
    for (;;) {
      if (hasGitEntry(current)) {
        cached = current.normalize('NFC')
        break
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    gitRootCache.set(start, cached)
  }
  return cached === NOT_FOUND ? null : cached
}

/**
 * Follow a worktree's `.git` file → `gitdir:` → `commondir` chain to the main
 * repository. Regular repos and submodules (no `commondir`) return `gitRoot`.
 */
function resolveCanonicalRoot(gitRoot: string): string {
  const cached = canonicalRootCache.get(gitRoot)
  if (cached !== undefined) return cached
  const resolved = readCanonicalRoot(gitRoot)
  canonicalRootCache.set(gitRoot, resolved)
  return resolved
}

function readCanonicalRoot(gitRoot: string): string {
  try {
    // A regular repo's `.git` is a directory, so this throws EISDIR.
    const gitContent = fs
      .readFileSync(path.join(gitRoot, '.git'), 'utf-8')
      .trim()
    if (!gitContent.startsWith('gitdir:')) return gitRoot
    const worktreeGitDir = path.resolve(
      gitRoot,
      gitContent.slice('gitdir:'.length).trim(),
    )
    const commonDir = path.resolve(
      worktreeGitDir,
      fs.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf-8').trim(),
    )
    // `.git` and `commondir` are repo-controlled. Only accept the layout that
    // `git worktree add` creates, or a cloned repo could claim the identity
    // (memory, settings) of any trusted directory:
    //   1. the worktree gitdir is a direct child of <commonDir>/worktrees/
    //   2. its `gitdir` back-link points at this checkout's `.git`
    if (
      path.resolve(path.dirname(worktreeGitDir)) !==
      path.join(commonDir, 'worktrees')
    ) {
      return gitRoot
    }
    const backlink = fs.realpathSync(
      fs.readFileSync(path.join(worktreeGitDir, 'gitdir'), 'utf-8').trim(),
    )
    if (backlink !== path.join(fs.realpathSync(gitRoot), '.git')) {
      return gitRoot
    }
    // Bare-repo worktrees have no main working tree; the common dir is the
    // stable identity.
    if (path.basename(commonDir) !== '.git') {
      return commonDir.normalize('NFC')
    }
    return path.dirname(commonDir).normalize('NFC')
  } catch {
    return gitRoot
  }
}

/**
 * Canonical repository root, resolving worktrees to the main checkout so all
 * worktrees of a repo share project-scoped state.
 */
export function findCanonicalGitRoot(cwd: string): string | null {
  const root = findGitRoot(cwd)
  return root ? resolveCanonicalRoot(root) : null
}

export function _clearGitRootCacheForTest(): void {
  gitRootCache.clear()
  canonicalRootCache.clear()
}
