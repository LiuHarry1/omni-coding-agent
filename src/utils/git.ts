/**
 * Minimal git helpers.
 */
import { spawnSync } from 'child_process'
import { getCwd } from './workspace/cwd.js'

/** Whether `getCwd()` is inside a git work tree. */
export async function getIsGit(): Promise<boolean> {
  try {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: getCwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2000,
    })
    return r.status === 0 && String(r.stdout ?? '').trim() === 'true'
  } catch {
    return false
  }
}
