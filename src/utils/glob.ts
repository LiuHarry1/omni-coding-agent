/**
 * Glob runner. Shells out to ripgrep:
 *   `rg --files --glob <pattern> --sort=modified [--no-ignore] [--hidden]`
 *
 * Default behavior (matches what most "find files" tooling does):
 *   - Hidden files included (`--hidden`).
 *   - .gitignore NOT respected (`--no-ignore`). This is intentional so
 *     the agent can find dist/, build artifacts, and untracked files.
 *     Flip via env: GLOB_NO_IGNORE=false → respect .gitignore.
 *   - Hidden files: set GLOB_HIDDEN=false to exclude them.
 *
 * Absolute patterns are split via `extractGlobBaseDirectory` because
 * ripgrep's --glob flag only accepts relative patterns.
 */

import { basename, dirname, isAbsolute, join, sep } from 'path'
import { ripGrep } from './ripgrep.js'
import { isWindows } from './platform.js'
import { buildRgExcludeGlobs, envBool } from '../constants/file_filters.js'

/**
 * Extracts the static base directory from a glob pattern. The base
 * directory is everything before the first glob special character
 * (* ? [ {). Returns the directory portion and the remaining relative
 * pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters — this is a literal path. Return the directory
    // portion and filename as pattern.
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  const staticPrefix = pattern.slice(0, match.index)
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob — pattern is relative to cwd.
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on
  // Windows). When lastSepIndex is 0, baseDir is empty but we need to use
  // '/' as the root.
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt). 'C:' means "current
  // directory on drive C" (relative), not root. We need 'C:/' or 'C:\'
  // for the actual drive root.
  if (isWindows && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

/** Ripgrep argv for file-listing glob (shared by utils/glob + remote Worker rg). */
export function buildGlobRgArgs(searchPattern: string): string[] {
  const noIgnore = envBool(process.env.GLOB_NO_IGNORE, true)
  const hidden = envBool(process.env.GLOB_HIDDEN, true)
  return [
    '--files',
    '--glob',
    searchPattern,
    '--sort=modified',
    ...(noIgnore ? ['--no-ignore'] : []),
    ...(hidden ? ['--hidden'] : []),
    ...buildRgExcludeGlobs('vcs+deps'),
  ]
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting
  // to relative pattern. ripgrep's --glob flag only works with relative
  // patterns.
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  // Use ripgrep for better memory performance.
  //   --files          list files instead of searching content
  //   --glob           filter by pattern
  //   --sort=modified  sort by modification time (oldest first; we reverse below)
  //   --no-ignore      don't respect .gitignore (default true; override with
  //                    GLOB_NO_IGNORE=false)
  //   --hidden         include hidden files (default true; override with
  //                    GLOB_HIDDEN=false)
  // env defaults (true) match the historical behavior — see comment block
  // above. Use `envBool` (not naive equality) so `GLOB_NO_IGNORE=false`
  // works even when tsx leaves a trailing inline `# comment` in the value.
  const args = buildGlobRgArgs(searchPattern)

  const allPaths = await ripGrep(args, searchDir, abortSignal)

  // ripgrep returns relative paths; convert to absolute.
  const absolutePaths = allPaths.map(p =>
    isAbsolute(p) ? p : join(searchDir, p),
  )

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  return { files, truncated }
}
