import path from 'path'
import type {
  AgentDefinition,
  AgentMode,
  AgentPermissionMode,
  AgentSource,
  MCPServerConfig,
} from '../../core/types.js'
import { parseHooksConfig } from '../../core/settings-manager.js'
import {
  sourceRank,
  type MarkdownFile,
} from '../../utils/markdownConfigLoader.js'
import {
  parseToolList,
  parseBool,
  parsePositiveInt,
  parseString,
  parseIdentifier,
} from '../../utils/frontmatterParser.js'
import { isModelTier } from '../../core/llm/index.js'
import {
  AGENT_TOOL_NAME,
  INTERACTIVE_TOOLS,
} from '../../constants/tool_names.js'
import { parseMemoryPolicy } from './memoryPolicy.js'

/** Names that must not be used as ModePicker primary agentTypes. */
const RESERVED_PRIMARY_AGENT_TYPES = new Set([
  'Plan',
  'Explore',
  'agent',
  'ask',
  'plan',
  'general-purpose',
])

export interface AgentParseResult {
  agent: AgentDefinition | null
  filePath: string
  error?: string
}

function parseAgentMode(value: unknown): AgentMode | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === 'primary') return 'primary'
  if (v === 'subagent') return 'subagent'
  return undefined
}

function parsePermissionMode(
  agentType: string,
  value: unknown,
): AgentPermissionMode | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (v === 'plan' || v === 'ask' || v === 'dontAsk') return v
  if (v === 'agent' || v === 'default' || v === 'acceptEdits') return 'agent'
  console.warn(
    `[agents] agent '${agentType}': permissionMode '${v}' is not supported; ignored`,
  )
  return undefined
}

function isServerConfig(value: unknown): value is MCPServerConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.command === 'string' || typeof v.url === 'string'
}

/** `mcpServers:` — server names, or `{ name: config }` entries. */
function parseMcpServers(
  value: unknown,
): Array<string | Record<string, MCPServerConfig>> | undefined {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([k, v]) => ({ [k]: v }))
      : typeof value === 'string'
        ? value.split(',')
        : []
  const out: Array<string | Record<string, MCPServerConfig>> = []
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
    } else if (item && typeof item === 'object') {
      for (const [name, config] of Object.entries(item)) {
        if (isServerConfig(config)) out.push({ [name]: config })
      }
    }
  }
  return out.length > 0 ? out : undefined
}

/** An agent finishing is its Stop: `SubagentStop` hooks are Stop hooks here. */
function subagentStopAsStop(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('SubagentStop' in value)) {
    return value
  }
  const { SubagentStop, Stop, ...rest } = value as Record<string, unknown>
  return {
    ...rest,
    Stop: [
      ...(Array.isArray(Stop) ? Stop : []),
      ...(Array.isArray(SubagentStop) ? SubagentStop : []),
    ],
  }
}

export function parseAgentFromMarkdown(file: MarkdownFile): AgentParseResult {
  const fm = file.frontmatter

  const agentType = parseIdentifier(fm.name)
  if (!agentType) {
    return { agent: null, filePath: file.filePath }
  }

  const whenToUse = parseString(fm.description)
  if (!whenToUse) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': missing or empty 'description' in frontmatter`,
    }
  }

  const body = file.body.trim()
  if (!body) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': markdown body (the system prompt) is empty`,
    }
  }

  const tools = parseToolList(fm.tools)
  const disallowedRaw = parseToolList(fm.disallowedTools)

  if (tools !== undefined && disallowedRaw !== undefined) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': specify either 'tools' (allow-list) or 'disallowedTools' (deny-list), not both`,
    }
  }

  const mode = parseAgentMode(fm.mode) ?? 'subagent'
  if (mode === 'primary' && RESERVED_PRIMARY_AGENT_TYPES.has(agentType)) {
    return {
      agent: null,
      filePath: file.filePath,
      error: `agent '${agentType}': name is reserved and cannot be mode: primary`,
    }
  }

  let allowedTools = tools
  if (allowedTools) {
    allowedTools = allowedTools.filter(t => t !== AGENT_TOOL_NAME)
  }

  // Primary stores only explicit frontmatter denies (globs ok).
  // Subagent path keeps auto-deny of Agent + interactive tools.
  let disallowed: string[] | undefined
  if (allowedTools === undefined) {
    if (mode === 'primary') {
      disallowed = disallowedRaw ? [...disallowedRaw] : undefined
    } else {
      disallowed = disallowedRaw
        ? Array.from(new Set([...disallowedRaw, AGENT_TOOL_NAME]))
        : [...INTERACTIVE_TOOLS, AGENT_TOOL_NAME]
    }
  }

  const filename = path.basename(file.filePath, '.md')

  const {
    policy: memoryPolicy,
    scope: memory,
    warnings: memoryWarnings,
  } = parseMemoryPolicy(fm.memory)
  for (const w of memoryWarnings) {
    console.warn(`[agents] agent '${agentType}': ${w}`)
  }

  const agent: AgentDefinition = {
    agentType,
    whenToUse,
    description: parseString(fm.label) ?? `Custom agent (${filename})`,
    systemPrompt: body,
    source: file.source as AgentSource,
    filePath: file.filePath,
    mode,
    ...(allowedTools !== undefined ? { tools: allowedTools } : {}),
    ...(disallowed !== undefined ? { disallowedTools: disallowed } : {}),
    ...(parsePositiveInt(fm.maxSteps) !== undefined
      ? { maxSteps: parsePositiveInt(fm.maxSteps) }
      : {}),
    ...(parseString(fm.model) !== undefined
      ? { model: parseString(fm.model) }
      : {}),
    ...(isModelTier(parseString(fm.modelTier))
      ? { modelTier: parseString(fm.modelTier) as 'large' | 'medium' | 'small' }
      : {}),
    ...(parseString(fm.label) !== undefined
      ? { label: parseString(fm.label) }
      : {}),
    ...(parseBool(fm.omitProjectRules) === true
      ? { omitProjectRules: true }
      : {}),
    ...(memory ? { memory } : {}),
    ...(memoryPolicy ? { memoryPolicy } : {}),
  }
  const permissionMode = parsePermissionMode(agentType, fm.permissionMode)
  if (permissionMode) agent.permissionMode = permissionMode
  const hooks = parseHooksConfig(subagentStopAsStop(fm.hooks))
  if (hooks) agent.hooks = hooks
  const mcpServers = parseMcpServers(fm.mcpServers)
  if (mcpServers) agent.mcpServers = mcpServers
  const skills = parseToolList(fm.skills)
  if (skills?.length) agent.skills = skills
  if (parseBool(fm.background) === true) agent.background = true
  if (fm.isolation === 'worktree') agent.isolation = 'worktree'

  return { agent, filePath: file.filePath }
}

export function mergeAgents(
  builtins: readonly AgentDefinition[],
  files: readonly MarkdownFile[],
): {
  agents: AgentDefinition[]
  allAgents: AgentDefinition[]
  errors: Array<{ filePath: string; error: string }>
} {
  const errors: Array<{ filePath: string; error: string }> = []
  const byType = new Map<string, AgentDefinition>()
  const allAgents: AgentDefinition[] = builtins.map(b => ({
    ...b,
    source: 'built-in' as const,
    mode: b.mode ?? ('subagent' as const),
  }))

  const builtinTypes = new Set(builtins.map(b => b.agentType))
  for (const b of allAgents) byType.set(b.agentType, b)

  const ordered = [...files].sort(
    (a, b) => sourceRank(a.source) - sourceRank(b.source),
  )

  for (const f of ordered) {
    const { agent, error, filePath } = parseAgentFromMarkdown(f)
    if (error) {
      errors.push({ filePath, error })
      console.warn(`[agents] ${error} (${filePath})`)
    }
    if (agent) {
      allAgents.push(agent)
      // Trust boundary: third-party plugins must not shadow built-in agents.
      // Some implementations enforce this structurally via `{plugin}:{name}`
      // namespacing; we use flat names, so guard explicitly.
      if (f.source === 'plugin' && builtinTypes.has(agent.agentType)) {
        const msg = `plugin agent '${agent.agentType}' may not override a built-in agent; ignored`
        errors.push({ filePath, error: msg })
        console.warn(`[agents] ${msg} (${filePath})`)
        continue
      }
      if (byType.has(agent.agentType)) {
        console.log(
          `[agents] overriding '${agent.agentType}' from ${f.filePath}`,
        )
      }
      byType.set(agent.agentType, agent)
    }
  }

  return { agents: [...byType.values()], allAgents, errors }
}

/** Resolve a primary profile for the main thread, or null. */
export function findPrimaryAgent(
  agents: readonly AgentDefinition[],
  agentType: string | null | undefined,
): AgentDefinition | null {
  if (!agentType) return null
  const found = agents.find(a => a.agentType === agentType)
  if (!found || found.mode !== 'primary') return null
  return found
}
