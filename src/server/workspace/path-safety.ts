import * as path from 'path'

/**
 * Expand `~` and resolve to an absolute path. **Does not sandbox** — this
 * module is for a local single-user tool where the agent already has full
 * filesystem access. The directory picker in the UI explicitly needs to
 * navigate / mkdir anywhere on disk (e.g. to create a new workspace folder).
 *
 * If `cwd` is provided, relative paths are resolved against it; otherwise
 * `process.cwd()` is used.
 */
export function resolvePath(input: string, cwd?: string): string {
  if (!input) throw new Error('Empty path')
  const expanded = input.replace(/^~/, process.env.HOME || '/')
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd || process.cwd(), expanded)
}

/**
 * Validate a single path segment (a file or directory name). Used when
 * the caller supplies a parent directory + a name, and we want to refuse
 * names that would silently traverse or break the tree.
 */
export function assertSafeName(name: string): void {
  if (!name || name === '.' || name === '..') throw new Error('Invalid name')
  if (name.includes('/') || name.includes('\\'))
    throw new Error('Name must not contain path separators')
  if (name.includes('\0')) throw new Error('Invalid name')
}

/** True when any path segment addresses Git's writable metadata directory. */
export function containsGitMetadataPath(input: string): boolean {
  return String(input)
    .split(/[\\/]+/)
    .some(segment => segment.toLowerCase() === '.git')
}
