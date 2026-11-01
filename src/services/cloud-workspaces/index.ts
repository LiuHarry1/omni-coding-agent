import * as path from 'path'
import {
  isCloudWorkspacesEnabled,
  loadCloudWorkspaceConfig,
} from '../../execution/providers/cloud/config.js'
import { WorkspaceContainers } from '../../execution/providers/cloud/containers.js'
import { getProcessAppDir } from '../../utils/app-dir.js'
import { CloudWorkspaceManager } from './manager.js'
import { CloudWorkspaceStore } from './store.js'

export {
  CloudWorkspaceError,
  CloudWorkspaceManager,
  validateRef,
  validateRepoUrl,
  type CreateCloudWorkspaceInput,
} from './manager.js'
export type {
  CloudWorkspaceRecord,
  CloudWorkspaceSource,
  CloudWorkspaceStatus,
} from './store.js'

let manager: CloudWorkspaceManager | null = null

/** Build the process-wide manager when CLOUD_WORKSPACES=docker; else null. */
export function initCloudWorkspaces(): CloudWorkspaceManager | null {
  if (manager) return manager
  if (!isCloudWorkspacesEnabled()) return null
  const config = loadCloudWorkspaceConfig()
  manager = new CloudWorkspaceManager({
    store: new CloudWorkspaceStore(
      path.join(getProcessAppDir(), 'cloud-workspaces'),
    ),
    containers: new WorkspaceContainers(config),
    allowedGitHosts: (process.env.WORKSPACE_GIT_HOSTS ?? '')
      .split(',')
      .map(h => h.trim())
      .filter(Boolean),
  })
  manager.failInterruptedProvisioning()
  return manager
}

/** Periodically remove idle containers. Returns a stop function. */
export function startCloudWorkspaceSweeper(
  target: CloudWorkspaceManager,
  intervalMs = 60_000,
): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void target
      .sweepIdle()
      .then(stopped => {
        if (stopped.length > 0) {
          console.log(
            `[cloud-workspaces] stopped idle container(s): ${stopped.join(', ')}`,
          )
        }
      })
      .catch(err => {
        console.warn(
          `[cloud-workspaces] idle sweep failed: ${err instanceof Error ? err.message : err}`,
        )
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export function getCloudWorkspaceManager(): CloudWorkspaceManager | null {
  return manager
}

export function setCloudWorkspaceManagerForTesting(
  next: CloudWorkspaceManager | null,
): void {
  manager = next
}
