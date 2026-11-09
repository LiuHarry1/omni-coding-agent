import * as fs from 'fs'
import * as path from 'path'

/** uid/gid of the cloud sandbox (`--user 1000:1000`). */
export const SANDBOX_UID = 1000
export const SANDBOX_GID = 1000

/**
 * Hand a root-created file or directory to the sandbox user. No-op when this
 * process is not root (local runs, tests). Does not follow symlinks.
 */
export function claimForSandboxUser(
  target: string,
  uid = SANDBOX_UID,
  gid = SANDBOX_GID,
): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    const st = fs.lstatSync(target)
    if (st.isSymbolicLink()) return
    if (st.uid === uid && st.gid === gid) return
    fs.lchownSync(target, uid, gid)
  } catch {
    // Missing path, or a platform that cannot change ownership.
  }
}

/**
 * Memory files are written by the root control plane. Own every existing
 * path from `.ai-agent` down to `filePath` so the sandbox can read and delete
 * them in the same turn. Stops at the first symlink.
 */
export function claimAiAgentPath(filePath: string): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  const parts = filePath.split(path.sep)
  const anchor = parts.lastIndexOf('.ai-agent')
  if (anchor < 0) return
  for (let i = anchor; i < parts.length; i++) {
    const current = parts.slice(0, i + 1).join(path.sep)
    let st: fs.Stats
    try {
      st = fs.lstatSync(current)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    claimForSandboxUser(current)
  }
}
