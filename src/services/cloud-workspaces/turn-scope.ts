import * as path from 'path'
import { requireSessionLocation } from '../../core/session-paths.js'
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
  /** Execution environment selected by the session. */
  environmentId: string
  /** Stable project anchor: the bound workspace cwd, else the requested cwd. */
  projectRoot: string
  /** Cwd for this turn's tools, kept under projectRoot for remote environments. */
  cwd: string
  /** Host cwd passed to the layered settings resolver. */
  settingsCwd: string
  /** Host cwd passed to extension loaders. */
  extensionCwd: string
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
 * Resolve once per entry point and pass the result down. Keeps control-plane
 * configuration paths separate from the execution cwd.
 *
 * Cloud turns are intentionally strict: without a request-scoped agent home,
 * loading extensions could fall back to another tenant or the server account.
 */
export function resolveWorkspaceContext(
  workspace: WorkspaceHandle | undefined,
  requestedCwd: string,
): WorkspaceContext {
  const environmentId = workspace?.environmentId ?? 'local'
  const remote = Boolean(workspace && environmentId !== 'local')
  const requested = normalizeWorkspacePath(requestedCwd)
  const projectRoot = normalizeWorkspacePath(workspace?.cwd ?? requested)
  let cwd = requested
  if (remote && !isPathAtOrBelow(requested, projectRoot)) {
    cwd = projectRoot
    console.warn(
      '[workspace] cwd outside the remote project root; using the root',
      JSON.stringify({ environmentId, requestedCwd: requested, projectRoot }),
    )
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
      environmentId,
      projectRoot,
      cwd,
      settingsCwd: agentHome,
      extensionCwd: agentHome,
      extensionRoot: path.join(agentHome, getAppDirName()),
      cloudWorkspaceId,
      remote: true,
    }
  }

  const controlPlaneCwd = remote ? getDefaultWorkspace() : cwd
  return {
    environmentId,
    projectRoot,
    cwd,
    settingsCwd: controlPlaneCwd,
    extensionCwd: controlPlaneCwd,
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
