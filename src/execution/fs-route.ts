/**
 * Which disk a read-side file tool (Read, Grep, Glob) should use in a
 * non-local session.
 *
 * Shell and workspace files live in the SSH host or cloud container. Harness
 * files (tool-results spills, plans, scratch, browser logs, uploads) are
 * written by the agent process on its own disk and never exist in the
 * workspace, so every read tool serves them from the agent host. Keeping the
 * decision here stops one tool from honoring the exemption while another
 * refuses the same path.
 */
import * as path from 'path'
import { isReadableInternalPath } from '../core/session-paths.js'

/**
 * True when `requested` names an agent-host harness path. Only absolute
 * host paths qualify: relative and `~` paths belong to the workspace, and
 * the check runs before `execution.resolve` so a Windows host path is not
 * joined onto a POSIX workspace cwd.
 */
export function readsFromAgentHost(requested: string | undefined): boolean {
  if (typeof requested !== 'string') return false
  const trimmed = requested.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return false
  return isReadableInternalPath(path.resolve(trimmed))
}

/**
 * Write-side counterpart: true when `requested` is an absolute path under one
 * of the session's host write roots (plans, auto-memory). Write and Edit then
 * use the host FS path, which still enforces the permission sandbox.
 */
export function writesToAgentHost(
  requested: string | undefined,
  hostWriteRoots: readonly string[] | undefined,
): boolean {
  if (typeof requested !== 'string' || !hostWriteRoots?.length) return false
  const trimmed = requested.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return false
  const abs = path.resolve(trimmed)
  return hostWriteRoots.some(root => {
    const rel = path.relative(path.resolve(root), abs)
    return (
      rel === '' ||
      (rel !== '..' &&
        !rel.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(rel))
    )
  })
}

/** Path shown to the model: cwd-relative inside cwd, absolute otherwise. */
export function displayPathFromCwd(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs)
  if (rel === '') return abs.replaceAll('\\', '/')
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return abs.replaceAll('\\', '/')
  }
  return rel.replaceAll('\\', '/')
}
