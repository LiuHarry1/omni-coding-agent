import * as path from 'path'
import {
  computeProjectKey,
  requireSessionLocation,
} from '../../core/session-paths.js'
import {
  getDefaultWorkspace,
  normalizeWorkspacePath,
} from '../../core/workspace.js'
import { parseCloudEnvironmentId } from '../../execution/providers/cloud/cloud-provider.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { getAgentHome, getRequestScope } from '../../utils/request-scope.js'
import { getCloudWorkspaceManager } from './index.js'

export { filterHttpMCPServers as filterCloudMCPServers } from '../../core/mcp-policy.js'

export type WorkspaceContext = {
  /** User-owned configuration and persistence root on the control plane. */
  agentHome?: string
  /** Execution environment selected by the session. */
  environmentId: string
  /** Stable project anchor inside the selected environment. */
  workspaceRoot: string
  /** Per-turn cwd, constrained to workspaceRoot for remote environments. */
  executionCwd: string
  /** Stable persistence identity derived from environmentId + workspaceRoot. */
  projectKey: string
  /** Explicitly approved roots outside workspaceRoot. */
  additionalRoots: string[]
  /** The cwd supplied by the entry point, retained for drift diagnostics. */
  requestedCwd: string
  cwdDrifted: boolean
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

export type TurnWorkspaceScope = WorkspaceContext

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
  additionalRoots: string[] = [],
): TurnWorkspaceScope {
  const environmentId = workspace?.environmentId ?? 'local'
  const remote = Boolean(workspace && environmentId !== 'local')
  const requestedCwd = normalizeWorkspacePath(toolCwd)
  const workspaceRoot = normalizeWorkspacePath(
    remote ? workspace!.cwd : requestedCwd,
  )
  const executionCwd =
    remote && !isPathAtOrBelow(requestedCwd, workspaceRoot)
      ? workspaceRoot
      : requestedCwd
  const normalizedWorkspace = {
    environmentId,
    cwd: workspaceRoot,
  }
  const cloudWorkspaceId = parseCloudEnvironmentId(workspace?.environmentId)
  if (cloudWorkspaceId) {
    const agentHome = cloudAgentHome()
    if (!agentHome) {
      throw new Error(
        'Cloud turn has no request-scoped agent home; refusing to load configuration',
      )
    }
    return {
      agentHome,
      environmentId,
      workspaceRoot,
      executionCwd,
      projectKey: computeProjectKey(normalizedWorkspace),
      additionalRoots: additionalRoots.map(normalizeWorkspacePath),
      requestedCwd,
      cwdDrifted: requestedCwd !== executionCwd,
      toolCwd: executionCwd,
      extensionCwd: agentHome,
      settingsCwd: agentHome,
      extensionRoot: path.join(agentHome, getAppDirName()),
      cloudWorkspaceId,
      remote: true,
    }
  }

  const controlPlaneCwd = remote ? getDefaultWorkspace() : executionCwd
  const agentHome = getRequestScope()?.agentHome
  return {
    agentHome,
    environmentId,
    workspaceRoot,
    executionCwd,
    projectKey: computeProjectKey(
      remote ? normalizedWorkspace : undefined,
      executionCwd,
    ),
    additionalRoots: additionalRoots.map(normalizeWorkspacePath),
    requestedCwd,
    cwdDrifted: requestedCwd !== executionCwd,
    toolCwd: executionCwd,
    extensionCwd: controlPlaneCwd,
    settingsCwd: controlPlaneCwd,
    cloudWorkspaceId: null,
    remote,
  }
}

function isPathAtOrBelow(candidate: string, root: string): boolean {
  if (!candidate || !root) return false
  if (candidate === root) return true

  if (root === '~') return candidate.startsWith('~/')
  if (root.startsWith('~/')) {
    return candidate.startsWith(`${root.replace(/\/+$/, '')}/`)
  }

  const pathApi = /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path.posix
  const relative = pathApi.relative(root, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  )
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
      comparableSandboxPath(agentHome) ===
      comparableSandboxPath(
        manager.containers.mountedUserHome(record.ownerEmail),
      )
    )
  } catch {
    return false
  }
}

function comparableSandboxPath(value: string): string {
  let normalized = normalizeWorkspacePath(value).replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) normalized = normalized.slice(2)
  return path.posix.normalize(normalized)
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
