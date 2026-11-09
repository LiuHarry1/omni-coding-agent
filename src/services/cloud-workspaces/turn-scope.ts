import * as path from 'path'
import { requireSessionLocation } from '../../core/session-paths.js'
import { getDefaultWorkspace } from '../../core/workspace.js'
import { parseCloudEnvironmentId } from '../../execution/providers/cloud/cloud-provider.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { getAgentHome, getRequestScope } from '../../utils/request-scope.js'
import { getCloudWorkspaceManager } from './index.js'

export { filterHttpMCPServers as filterCloudMCPServers } from '../../core/mcp-policy.js'

export type TurnWorkspaceScope = {
  /** Tool paths always stay inside the selected execution environment. */
  toolCwd: string
  /** Host cwd passed to extension loaders. */
  extensionCwd: string
  /** Host cwd passed to the layered settings resolver. */
  settingsCwd: string
  /** Exact cloud user configuration root, when this is a cloud turn. */
  extensionRoot?: string
  cloudWorkspaceId: string | null
  remote: boolean
}

/** Request-scoped agent home, or HOME for single-user local cloud dev. */
function cloudAgentHome(): string | undefined {
  const request = getRequestScope()
  if (request?.agentHome) return request.agentHome
  try {
    // Single-user local cloud development has no HTTP request scope; HOME
    // is isolated by cloud-dev and remains the canonical user source.
    return getAgentHome()
  } catch {
    // AUTH must always supply the authenticated tenant scope.
    return undefined
  }
}

/**
 * Keep control-plane configuration paths separate from the execution cwd.
 *
 * Cloud turns are intentionally strict: without a request-scoped agent home,
 * loading extensions could fall back to another tenant or the server account.
 */
export function resolveTurnWorkspaceScope(
  workspace: WorkspaceHandle | undefined,
  toolCwd: string,
): TurnWorkspaceScope {
  const cloudWorkspaceId = parseCloudEnvironmentId(workspace?.environmentId)
  if (cloudWorkspaceId) {
    const agentHome = cloudAgentHome()
    if (!agentHome) {
      throw new Error(
        'Cloud turn has no request-scoped agent home; refusing to load configuration',
      )
    }
    return {
      toolCwd,
      extensionCwd: agentHome,
      settingsCwd: agentHome,
      extensionRoot: path.join(agentHome, getAppDirName()),
      cloudWorkspaceId,
      remote: true,
    }
  }

  const remote = Boolean(workspace && workspace.environmentId !== 'local')
  const controlPlaneCwd = remote ? getDefaultWorkspace() : toolCwd
  return {
    toolCwd,
    extensionCwd: controlPlaneCwd,
    settingsCwd: controlPlaneCwd,
    cloudWorkspaceId: null,
    remote,
  }
}

/**
 * True when the cloud sandbox sees this turn's `.ai-agent` at the same path:
 * the turn's agent home is the workspace owner's mounted user directory.
 * A super user in another user's workspace, SSH, local, or any lookup failure
 * is false, so callers keep their host-only fallbacks.
 */
export function cloudSandboxSeesAgentHome(
  workspace: WorkspaceHandle | undefined,
  agentHome: string | undefined = cloudAgentHome(),
): boolean {
  const id = parseCloudEnvironmentId(workspace?.environmentId)
  if (!id || !agentHome) return false
  const manager = getCloudWorkspaceManager()
  const record = manager?.get(id)
  if (!manager || !record) return false
  try {
    return (
      path.resolve(agentHome) ===
      manager.containers.mountedUserHome(record.ownerEmail)
    )
  } catch {
    return false
  }
}

/**
 * Uploads and tool-result spills live under the session's agent home, so the
 * sandbox can open them at their host paths exactly when that home is the
 * one mounted into the workspace.
 */
export function cloudSandboxSeesSessionFiles(
  workspace: WorkspaceHandle | undefined,
  sessionId: string,
): boolean {
  let agentHome: string
  try {
    agentHome = requireSessionLocation(sessionId).agentHome
  } catch {
    return false
  }
  return cloudSandboxSeesAgentHome(workspace, agentHome)
}
