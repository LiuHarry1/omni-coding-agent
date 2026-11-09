/**
 * Copy composer uploads into the environment where shell commands run.
 *
 * Uploads are stored on the agent host (`{agentHome}/.ai-agent/uploads/`).
 * Local turns share that disk, and so does a cloud container whose mounted
 * `.ai-agent` belongs to the session's agent home. SSH hosts, and a cloud
 * container opened by someone other than its owner, do not, so a host path
 * handed to the model is a dead end for Bash there. Same idea as Claude
 * Code's bridge attachments: write the bytes where the tools run and
 * reference that path.
 *
 * The Read tool keeps the host path: it serves agent-host uploads directly
 * (`isReadableInternalPath`) in every environment.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getExecutionPlane } from '../../execution/bootstrap.js'
import { parseCloudEnvironmentId } from '../../execution/providers/cloud/cloud-provider.js'
import { loadCloudWorkspaceConfig } from '../../execution/providers/cloud/config.js'
import { ShellFsPort, remotePathShell } from '../../execution/shell-fs.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import { getAppDirName } from '../app-dir.js'

/** Large Office files over a slow SSH link need more than the default. */
const STAGE_TIMEOUT_MS = 10 * 60_000

/** Copies one host upload into the environment; resolves to its path there. */
export type ShellAttachmentStager = (hostPath: string) => Promise<string>

type StagerDeps = {
  openFs?: (environmentId: string) => Promise<unknown>
}

/**
 * Per-session uploads directory inside a non-local environment. Cloud
 * containers are removed when idle and only the volume survives, so the
 * directory must live on the volume rather than under `$HOME`.
 */
export function environmentUploadsDir(
  environmentId: string,
  sessionId: string,
): string {
  const tail = path.posix.join(getAppDirName(), 'uploads', sessionId)
  return parseCloudEnvironmentId(environmentId)
    ? path.posix.join(loadCloudWorkspaceConfig().volumeMount, tail)
    : `~/${tail}`
}

/** No stager for local turns: shell and uploads share the host disk. */
export function createShellAttachmentStager(
  workspace: WorkspaceHandle | undefined,
  sessionId: string,
  deps: StagerDeps = {},
): ShellAttachmentStager | undefined {
  if (!workspace || workspace.environmentId === 'local') return undefined
  const { environmentId } = workspace
  const openFs =
    deps.openFs ?? ((id: string) => getExecutionPlane().workspaces.ensureFs(id))

  let target: Promise<{ port: ShellFsPort; dir: string }> | undefined
  const prepare = async () => {
    const port = await openFs(environmentId)
    if (!(port instanceof ShellFsPort)) {
      throw new Error(`${environmentId} has no shell filesystem`)
    }
    const dir = environmentUploadsDir(environmentId, sessionId)
    await port.mkdir(dir)
    // SSH hosts can be shared machines; uploads are the user's private files.
    // Best effort: the files themselves are written 0600 below.
    await port.run(`chmod 700 ${remotePathShell(dir)}`)
    return { port, dir: await port.realpath(dir) }
  }

  return async hostPath => {
    target ??= prepare().catch(err => {
      target = undefined
      throw err
    })
    const { port, dir } = await target
    // Saved names are already `{uuid}-{sanitized}.{ext}` (CHAT_UPLOAD_ANY_FILE_RE).
    const dest = path.posix.join(dir, path.basename(hostPath))
    await port.writeFileAtomic(dest, fs.createReadStream(hostPath), {
      mode: 0o600,
      timeoutMs: STAGE_TIMEOUT_MS,
    })
    return dest
  }
}
