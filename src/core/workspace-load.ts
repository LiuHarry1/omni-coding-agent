/**
 * Shared workspace discovery for HTTP APIs and post-compact enrichment.
 * Single loadPlugins call per request.
 */
import { loadPlugins } from './plugins/loader.js'
import {
  pluginErrorMessage,
  pluginErrorSource,
  type PluginContributions,
} from './plugins/types.js'
import type { AgentDefinitionsResult } from './types.js'
import { loadAgentDefinitions } from '../tools/AgentTool/loadAgents.js'
import {
  loadSkillsFromDisk,
  mergeSkillsByName,
} from '../skills/loadSkillsDir.js'
import type { SkillDefinition } from '../skills/types.js'
import { seedUserWorkspaceIfNeeded } from './workspace-seed.js'
import { isCloudWorkspacesEnabled } from '../execution/providers/cloud/config.js'

export interface WorkspaceContributions {
  plugins: PluginContributions
  agents: AgentDefinitionsResult
  skills: SkillDefinition[]
  skillDiskErrors: Array<{ filePath: string; error: string }>
}

export function mapPluginErrors(
  plugins: PluginContributions,
): Array<{ filePath: string; error: string }> {
  return plugins.errors.map(e => ({
    filePath: pluginErrorSource(e),
    error: pluginErrorMessage(e),
  }))
}

export async function loadWorkspaceContributions(
  cwd: string,
): Promise<WorkspaceContributions> {
  // Desktop / non-Cloud SSO: apply the baked seed to the host workspace.
  // A Cloud cwd (for example /workspace/repo) belongs to the workspace
  // container and must never be written through the control-plane filesystem.
  if (!isCloudWorkspacesEnabled()) {
    seedUserWorkspaceIfNeeded(cwd)
  }

  const plugins = await loadPlugins(cwd)
  const agents = await loadAgentDefinitions(cwd, plugins.agentFiles)
  const { skills: diskSkills, errors: skillDiskErrors } =
    await loadSkillsFromDisk(cwd)
  const skills = mergeSkillsByName(plugins.skills, diskSkills)
  return { plugins, agents, skills, skillDiskErrors }
}
