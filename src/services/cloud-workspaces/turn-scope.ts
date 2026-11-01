import * as path from 'path'
import { getDefaultWorkspace } from '../../core/workspace.js'
import { parseCloudEnvironmentId } from '../../execution/providers/cloud/cloud-provider.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { getAgentHome, getRequestScope } from '../../utils/request-scope.js'

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
    const request = getRequestScope()
    let agentHome = request?.agentHome
    if (!agentHome) {
      try {
        // Single-user local cloud development has no HTTP request scope; HOME
        // is isolated by cloud-dev and remains the canonical user source.
        agentHome = getAgentHome()
      } catch {
        // AUTH must always supply the authenticated tenant scope.
      }
    }
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
