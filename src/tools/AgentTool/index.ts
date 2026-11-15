import type {
  AgentDefinition,
  AgentDefinitionsResult,
  IToolRegistry,
} from '../../core/types.js'
import { definition as exploreDef } from './built-in/exploreAgent.js'
import { definition as planDef } from './built-in/planAgent.js'
import { definition as generalPurposeDef } from './built-in/generalPurposeAgent.js'
import { createTaskTool } from './AgentTool.js'
import { createSendMessageTool } from './SendMessageTool.js'
import { AGENT_TOOL_NAME } from '../../constants/tool_names.js'
import type { MarkdownFile } from '../../utils/markdownConfigLoader.js'
import { loadAgentDefinitions } from './loadAgents.js'

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  exploreDef,
  planDef,
  generalPurposeDef,
]

export function registerBuiltinSubagents(registry: IToolRegistry): void {
  registry.register(createTaskTool(BUILTIN_AGENTS))
  registry.register(createSendMessageTool())
}

export async function registerSubagents(
  registry: IToolRegistry,
  cwd: string,
  pluginAgentFiles: readonly MarkdownFile[] = [],
): Promise<AgentDefinitionsResult> {
  const result = await loadAgentDefinitions(cwd, pluginAgentFiles)
  registry.register(createTaskTool(result.activeAgents))
  registry.register(createSendMessageTool())
  return result
}

export function getSubagentNames(registry: IToolRegistry): Set<string> {
  const names = new Set<string>()
  for (const { name } of registry.list()) {
    if (registry.get(name)?.isSubagent) names.add(name)
  }
  names.add(AGENT_TOOL_NAME)
  return names
}

// Re-export built-in agent types for prompts / tool description examples.
export { EXPLORE_AGENT_TYPE } from './built-in/exploreAgent.js'
export { PLAN_AGENT_TYPE } from './built-in/planAgent.js'
export { GENERAL_PURPOSE_AGENT_TYPE } from './built-in/generalPurposeAgent.js'
export {
  loadAgentDefinitions,
  loadAgentDefinitionsForWorkspace,
} from './loadAgents.js'
