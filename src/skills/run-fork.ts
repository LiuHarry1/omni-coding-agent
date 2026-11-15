/**
 * Run a `context: fork` skill as an isolated subagent. Shared by the
 * model-facing `skill` tool, HTTP `/skills/:name/invoke`, and user
 * slash invocation (`/skill-name`).
 */

import type {
  AgentDefinition,
  AnyTool,
  CompactionConfig,
  IEventBus,
  IProvider,
  IToolRegistry,
  ModelRegistry,
  RunAgentFn,
  ToolContext,
} from '../core/types.js'
import type { WireEmitter } from '../core/wire-emitter.js'
import { buildConcurrencyPolicy } from '../core/concurrency-policy.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/SkillTool.js'
import { SUBAGENT_NO_OUTPUT_MARKER } from '../tools/AgentTool/finalizeAgentTool.js'
import { isToolNameDisallowed } from '../tools/AgentTool/toolGlob.js'
import { enhanceSystemPromptWithEnvDetails } from '../constants/prompts.js'
import { setCwd } from '../utils/workspace/cwd.js'
import type { SkillDefinition } from './types.js'

export interface RunSkillForkOptions {
  skill: SkillDefinition
  /** Expanded skill body (preamble + substituted content). */
  combined: string
  cwd: string
  runAgent: RunAgentFn
  registry: IToolRegistry
  activeAgents: readonly AgentDefinition[]
  eventBus: IEventBus
  wire: WireEmitter
  toolEnablement?: ToolContext['toolEnablement']
  provider?: IProvider
  models?: ModelRegistry
  compaction?: CompactionConfig
  sessionId?: string
  permissionContext?: ToolContext['permissionContext']
  execution?: ToolContext['execution']
}

export async function runSkillFork(opts: RunSkillForkOptions): Promise<string> {
  const {
    skill,
    combined,
    cwd,
    runAgent,
    registry,
    activeAgents,
    eventBus,
    wire,
    toolEnablement,
    provider,
    models,
    compaction,
    sessionId,
    permissionContext,
    execution,
  } = opts

  const targetAgentType = skill.agent ?? 'general_purpose'
  const targetAgent = activeAgents.find(a => a.agentType === targetAgentType)
  if (!targetAgent) {
    throw new Error(
      `Skill '${skill.name}' fork target '${targetAgentType}' not found. Available: ${activeAgents.map(a => a.agentType).join(', ')}`,
    )
  }

  wire.stepStart(0, {
    task: skill.name,
    label: `Skill: ${skill.name}`,
  })

  const tier = targetAgent.modelTier ?? 'large'
  const forkProvider = models?.provider(tier) ?? provider
  const forkModel =
    targetAgent.model ??
    models?.profile(tier).model ??
    forkProvider?.defaultModelId()

  const subContext: ToolContext = {
    eventBus,
    wire,
    registry,
    runAgent,
    toolEnablement,
    provider: forkProvider,
    models,
    compaction,
    sessionId,
    permissionContext,
    cwd,
    execution,
  }

  let subTools: Record<string, AnyTool>
  if (targetAgent.tools) {
    subTools = registry.createAll(cwd, subContext, targetAgent.tools)
  } else {
    subTools = registry.createAll(cwd, subContext)
    const patterns = targetAgent.disallowedTools ?? []
    for (const n of Object.keys(subTools)) {
      if (
        n === AGENT_TOOL_NAME ||
        n === SKILL_TOOL_NAME ||
        isToolNameDisallowed(n, patterns)
      ) {
        delete subTools[n]
      }
    }
  }
  delete subTools[AGENT_TOOL_NAME]
  delete subTools[SKILL_TOOL_NAME]

  if (!forkProvider) {
    throw new Error(
      `Skill '${skill.name}' fork requires a request-scoped provider`,
    )
  }

  setCwd(cwd)
  const systemPrompt = (
    await enhanceSystemPromptWithEnvDetails(
      [targetAgent.systemPrompt],
      forkModel ?? '',
    )
  ).join('\n\n')

  const result = await runAgent(combined, {
    throwOnError: true,
    tools: subTools,
    systemPrompt,
    eventBus,
    wire,
    messages: [],
    ...(targetAgent.maxSteps !== undefined
      ? { maxSteps: targetAgent.maxSteps }
      : {}),
    model: forkModel,
    provider: forkProvider,
    cwd,
    compaction,
    concurrencyPolicy: buildConcurrencyPolicy(registry),
    sessionId,
  })

  const text = typeof result === 'string' ? result.trim() : ''
  return text || SUBAGENT_NO_OUTPUT_MARKER
}
