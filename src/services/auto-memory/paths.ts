/**
 * Auto-memory path resolution helpers.
 */
import * as fs from 'fs'
import { claimAiAgentPath } from '../../utils/sandbox-owner.js'
import * as path from 'path'
import { getAgentHome } from '../../utils/request-scope.js'
import { getAppDirName, getUserAppDir } from '../../utils/app-dir.js'
import { findCanonicalGitRoot } from '../../utils/git-root.js'
import { sanitizePath } from '../../utils/sanitize-path.js'
import { isPathInWorkspace } from '../../core/workspace.js'

export const AUTO_MEM_ENTRYPOINT = 'MEMORY.md'
export const AUTO_MEM_DIRNAME = 'memory'

export { findCanonicalGitRoot, sanitizePath }

/**
 * Validate trusted user/managed overrides before they become filesystem
 * allowlist roots. Project and local settings are stripped earlier.
 */
function resolveTrustedDirectory(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\0')) return undefined

  // Reject UNC/network paths before normalize can collapse their prefix.
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    return undefined
  }

  let candidate = trimmed
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    const rest = candidate.slice(2)
    const restNorm = path.normalize(rest || '.')
    // Bare home and paths that collapse to home/an ancestor are too broad.
    if (restNorm === '.' || restNorm === '..') return undefined
    candidate = path.join(getAgentHome(), rest)
  }

  let normalized = path.normalize(candidate)
  if (!path.isAbsolute(normalized)) return undefined
  const root = path.parse(normalized).root
  if (normalized === root || normalized.length < 3) return undefined
  normalized = normalized.replace(/[/\\]+$/, '')
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return undefined
  normalized = normalized.normalize('NFC')

  // In SSO, user settings are tenant-controlled rather than machine-owner
  // trusted. Never let one tenant turn another tenant's directory into an
  // extra read/write root. Local Web, Electron, and admin deployments keep
  // the regular trusted-user override behavior.
  const authEnabled =
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  if (authEnabled && !isPathInWorkspace(normalized, getAgentHome())) {
    return undefined
  }

  return normalized
}

export type AutoMemPathOptions = {
  cwd: string
  /**
   * Trusted directory override (user or managed settings only).
   * Project and local settings must never supply this.
   */
  trustedDirectory?: string
}

/**
 * Resolve auto-memory directory.
 * Order: settings `autoMemory.directory` / `autoMemoryDirectory`
 * (via trustedDirectory) → default under ~/.ai-agent/projects/
 */
export function getAutoMemPath(opts: AutoMemPathOptions): string {
  if (opts.trustedDirectory?.trim()) {
    const trusted = resolveTrustedDirectory(opts.trustedDirectory)
    if (trusted) return trusted
    console.warn(
      '[auto-memory] ignoring unsafe directory override; using project-scoped default',
    )
  }
  const base = findCanonicalGitRoot(opts.cwd) ?? path.resolve(opts.cwd)
  // Keyed on the canonical git root so every worktree shares one memory dir;
  // session buckets use the raw cwd instead (computeProjectKey).
  return path.join(
    getUserAppDir(),
    'projects',
    sanitizePath(base),
    AUTO_MEM_DIRNAME,
  )
}

export function getAutoMemEntrypoint(memPath: string): string {
  return path.join(memPath, AUTO_MEM_ENTRYPOINT)
}

function resolveThroughExistingAncestor(input: string): string | null {
  let current = path.resolve(input)
  const missing: string[] = []
  try {
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) return null
      missing.unshift(path.basename(current))
      current = parent
    }
    return path.resolve(fs.realpathSync(current), ...missing)
  } catch {
    return null
  }
}

/** True when absPath is under the auto-memory directory (or is that dir). */
export function isAutoMemPath(absPath: string, memPath: string): boolean {
  const resolvedPath = path.resolve(absPath)
  const resolvedRoot = path.resolve(memPath)
  if (!isPathInWorkspace(resolvedPath, resolvedRoot)) return false

  // Lexical containment is insufficient: an existing symlink inside memdir
  // may point outside it. Resolve the nearest existing ancestor for both
  // existing and not-yet-created targets before granting access.
  const realPath = resolveThroughExistingAncestor(resolvedPath)
  const realRoot = resolveThroughExistingAncestor(resolvedRoot)
  return !!realPath && !!realRoot && isPathInWorkspace(realPath, realRoot)
}

/** Memory dirs are group-readable (755) so Glob/rg and multi-process deploys can traverse them. */
const AUTO_MEM_DIR_MODE = 0o755
const AUTO_MEM_FILE_MODE = 0o644

function chmodDirBestEffort(dir: string): void {
  try {
    fs.chmodSync(dir, AUTO_MEM_DIR_MODE)
  } catch {
    // Best-effort: repair legacy 0700 dirs on next session inject.
  }
}

/** Repair traverse perms on memory dir and its .ai-agent/projects/* ancestors. */
function repairMemoryDirTreePermissions(memPath: string): void {
  let dir = path.resolve(memPath)
  for (let i = 0; i < 4 && dir; i++) {
    chmodDirBestEffort(dir)
    const base = path.basename(dir)
    if (base === getAppDirName() || base === 'projects') {
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

export function ensureAutoMemDir(memPath: string): void {
  fs.mkdirSync(memPath, { recursive: true, mode: AUTO_MEM_DIR_MODE })
  repairMemoryDirTreePermissions(memPath)
  claimAiAgentPath(memPath)
  const entry = getAutoMemEntrypoint(memPath)
  if (!fs.existsSync(entry)) {
    fs.writeFileSync(entry, '', {
      encoding: 'utf-8',
      mode: AUTO_MEM_FILE_MODE,
    })
    claimAiAgentPath(entry)
  }
}

/** App dir basename for logging (e.g. .ai-agent). */
export function autoMemAppDirLabel(): string {
  return getAppDirName()
}
