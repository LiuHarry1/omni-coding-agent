/**
 * Read-only agent discovery — load disk/plugin agents and merge with
 * built-ins without mutating the tool registry.
 */
import type {
  AgentDefinitionsResult,
  AgentDefinition,
} from '../../core/types.js'
import {
  loadMarkdownConfigs,
  type MarkdownFile,
} from '../../utils/markdownConfigLoader.js'
import { loadPlugins } from '../../services/plugins/loader.js'
import { definition as exploreDef } from './built-in/exploreAgent.js'
import { definition as planDef } from './built-in/planAgent.js'
import { definition as generalPurposeDef } from './built-in/generalPurposeAgent.js'
import { mergeAgents } from './mergeAgents.js'
import { initializeAgentMemorySnapshots } from './agentMemorySnapshot.js'

const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  exploreDef,
  planDef,
  generalPurposeDef,
]

/** Merge built-in + plugin + disk agents. Does not register tools. */
export async function loadAgentDefinitions(
  cwd: string,
  pluginAgentFiles: readonly MarkdownFile[] = [],
): Promise<AgentDefinitionsResult> {
  const files = await loadMarkdownConfigs('agents', cwd)
  const { agents, allAgents, errors } = mergeAgents(BUILTIN_AGENTS, [
    ...pluginAgentFiles,
    ...files,
  ])
  await initializeAgentMemorySnapshots(allAgents, cwd)
  return { activeAgents: agents, allAgents, errors }
}

/** loadPlugins + loadAgentDefinitions for a workspace cwd. */
export async function loadAgentDefinitionsForWorkspace(
  cwd: string,
): Promise<AgentDefinitionsResult> {
  const plugins = await loadPlugins(cwd)
  return loadAgentDefinitions(cwd, plugins.agentFiles)
}
