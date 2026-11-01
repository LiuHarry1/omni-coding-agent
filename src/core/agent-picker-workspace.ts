/**
 * Workspace-scoped agent picker helpers for session create / mode switches.
 */
import { resolveSettings } from './settings-manager.js'
import { loadWorkspaceContributions } from './workspace-load.js'
import type { WorkspaceHandle } from '../execution/types.js'
import { resolveTurnWorkspaceScope } from '../services/cloud-workspaces/turn-scope.js'
import {
  isAgentTypeAllowedByPicker,
  isModeAllowedByPicker,
  resolveAgentPicker,
  type ResolvedAgentPicker,
} from './agent-picker.js'
import type { Session } from './types.js'
import {
  createDefaultPermissionMode,
  type ExternalMode,
} from './permission-mode.js'

export async function loadAgentPickerWorkspace(
  workspace: WorkspaceHandle | undefined,
  toolCwd: string,
) {
  const scope = resolveTurnWorkspaceScope(workspace, toolCwd)
  const settings = resolveSettings(scope.settingsCwd)
  const contributions = await loadWorkspaceContributions(scope.extensionCwd)
  return {
    picker: resolveAgentPicker(
      settings.config.agents,
      contributions.agents.activeAgents,
    ),
    contributions,
    scope,
  }
}

export async function loadResolvedAgentPickerForWorkspace(
  workspace: WorkspaceHandle | undefined,
  toolCwd: string,
): Promise<ResolvedAgentPicker> {
  const { picker } = await loadAgentPickerWorkspace(workspace, toolCwd)
  return picker
}

/** Apply picker defaults onto a freshly created session. */
export function applyPickerDefaultsToSession(
  session: Session,
  picker: ResolvedAgentPicker,
): void {
  session.permissionMode = {
    ...createDefaultPermissionMode(),
    mode: picker.default.mode,
  }
  session.agentType = picker.default.agentType
}

export function pickerModeError(
  picker: ResolvedAgentPicker,
  mode: string,
): string | null {
  if (isModeAllowedByPicker(picker, mode)) return null
  if (picker.modes.length === 0) {
    return `Mode '${mode}' is not available (picker.modes is empty; only agent permission with a primary is allowed)`
  }
  return `Mode '${mode}' is not in picker.modes [${picker.modes.join(', ')}]`
}

export function pickerAgentTypeError(
  picker: ResolvedAgentPicker,
  agentType: string | null,
): string | null {
  if (isAgentTypeAllowedByPicker(picker, agentType)) return null
  if (agentType === null) {
    return 'Default coding agent (agentType null) is not available for this workspace picker'
  }
  const allowed = picker.primaries.map(a => a.agentType)
  return `agentType '${agentType}' is not in picker.primaries [${allowed.join(', ') || '(none)'}]`
}

export type { ResolvedAgentPicker, ExternalMode }
