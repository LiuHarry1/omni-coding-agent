import * as fs from 'fs'
import * as path from 'path'
import { getAgentHome } from './request-scope.js'

/**
 * Workspace = the default project root the agent operates on when a request
 * doesn't specify one. Resolved ONCE at boot from (in priority order):
 *
 *   1. CLI flag:   --workspace=/abs/path  or  --workspace /abs/path
 *   2. Env var:    WORKSPACE=/abs/path     (Docker-friendly)
 *   3. Fallback:   process.cwd()
 *
 * Per-request `workspace` body fields (see server/router.ts) override this
 * default; this is purely the floor.
 *
 * Boundary semantics (see `isPathInWorkspace` / filesystem permissions):
 *   - Desktop (`default`): in-workspace auto-allow; outside File tools ask.
 *   - Cloud (`dontAsk`, AUTH_ENABLED): outside the pinned working dir is deny.
 *   - Bash is not OS-sandboxed by this module.
 */

let cachedDefault: string | null = null

/** Cheap CLI parser. Accepts `--workspace=<path>` and `--workspace <path>`. */
function parseCliWorkspace(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--workspace' && i + 1 < argv.length) return argv[i + 1]
    if (arg && arg.startsWith('--workspace='))
      return arg.slice('--workspace='.length)
  }
  return undefined
}

function expandTilde(p: string): string {
  if (p === '~') return getAgentHome()
  if (p.startsWith('~/') || p.startsWith('~\\'))
    return path.join(getAgentHome(), p.slice(2))
  return p
}

function validateDir(p: string, source: string): string {
  const resolved = path.resolve(expandTilde(p))
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch (err) {
    throw new Error(
      `[workspace] ${source} points to "${resolved}" which does not exist: ${(err as Error).message}`,
      { cause: err },
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `[workspace] ${source} points to "${resolved}" which is not a directory`,
    )
  }
  return resolved
}

/**
 * Resolve and cache the default workspace. Idempotent — safe to call from
 * multiple modules at boot. Throws on a bad CLI/env value so the failure
 * surfaces at startup, not on the first tool call.
 */
export function resolveDefaultWorkspace(): string {
  if (cachedDefault) return cachedDefault

  const fromCli = parseCliWorkspace(process.argv.slice(2))
  if (fromCli) {
    cachedDefault = validateDir(fromCli, '--workspace')
    return cachedDefault
  }
  const fromEnv = process.env.WORKSPACE
  if (fromEnv && fromEnv.trim()) {
    cachedDefault = validateDir(fromEnv, 'WORKSPACE env')
    return cachedDefault
  }
  cachedDefault = path.resolve(process.cwd())
  return cachedDefault
}

/** Returns the cached default workspace without re-validating. */
export function getDefaultWorkspace(): string {
  return cachedDefault ?? resolveDefaultWorkspace()
}

export { normalizeWorkspacePath, isPosixAbsolutePath } from './path.js'

// ── Boundary check ───────────────────────────────────────────────────────────

const IS_CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32'

/** Normalize macOS `/private/{tmp,var}` ↔ `/{tmp,var}` so symlink pairs compare equal. */
function normalizeMacosPrivate(p: string): string {
  return p
    .replace(/^\/private\/var(\/|$)/, '/var$1')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
}

function normalizeForCompare(p: string): string {
  let n = path.resolve(normalizeMacosPrivate(p))
  if (IS_CASE_INSENSITIVE_FS) n = n.toLowerCase()
  return n
}

/**
 * True iff `targetPath` is inside (or equal to) `workspaceRoot`.
 *
 * Handles:
 *   - Relative inputs (resolved against `workspaceRoot`).
 *   - `~` expansion.
 *   - macOS `/private/tmp` ↔ `/tmp` symlink pair.
 *   - Case-insensitive filesystems on macOS / Windows.
 *   - `..` traversal — rejected via `path.relative` check.
 *
 * Does NOT follow symlinks on the target (intentional: a symlink inside the
 * workspace pointing at /etc/passwd would otherwise be a write hole). Callers
 * that need symlink-resolved comparison should `fs.realpathSync` the target
 * themselves and pass that in.
 */
export function isPathInWorkspace(
  targetPath: string,
  workspaceRoot: string,
): boolean {
  const expanded = expandTilde(targetPath)
  const absTarget = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded)

  const normTarget = normalizeForCompare(absTarget)
  const normRoot = normalizeForCompare(workspaceRoot)

  if (normTarget === normRoot) return true

  const rel = path.relative(normRoot, normTarget)
  if (!rel) return true
  if (rel.startsWith('..')) return false
  if (path.isAbsolute(rel)) return false
  return true
}

/**
 * Throws a user-facing error if `absPath` is outside `workspaceRoot`.
 * Use from write-side tools to enforce the boundary.
 */
export function assertPathInWorkspace(
  absPath: string,
  workspaceRoot: string,
): void {
  if (!isPathInWorkspace(absPath, workspaceRoot)) {
    throw new Error(
      `Refused: "${absPath}" is outside the workspace "${workspaceRoot}". ` +
        `Writes must stay inside the workspace.`,
    )
  }
}
