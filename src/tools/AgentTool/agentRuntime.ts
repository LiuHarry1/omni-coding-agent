/**
 * What an agent definition brings along at run time: MCP servers of its own
 * and skills loaded before it starts.
 *
 * As in Claude Code's `initializeAgentMcpServers`, a server the definition
 * names is the session's own connection and is left alone, while one it
 * configures inline is connected for this run and closed when the run ends.
 * Nothing is restricted beyond what session MCP already is: with cloud
 * workspaces on, only HTTP(S) servers connect.
 */
import { randomUUID } from 'crypto'
import type {
  AgentDefinition,
  AnyTool,
  MCPServerConfig,
  Message,
} from '../../core/types.js'
import { MCPManager } from '../../core/mcp-manager.js'
import { filterHttpMCPServers } from '../../core/mcp-policy.js'
import { isCloudWorkspacesEnabled } from '../../execution/providers/cloud/config.js'
import { loadSkillsFromDisk } from '../../skills/loadSkillsDir.js'
import { expandSkillBody } from '../../skills/expand.js'

export interface AgentMcp {
  tools: Record<string, AnyTool>
  /** Disconnects the inline servers; the session's own are not touched. */
  close: () => Promise<void>
}

/**
 * Tools of the servers the definition lists: a name picks a server the
 * session already has; an inline config is connected for this run only.
 * The caller must `close()` when the agent is done.
 */
export async function connectAgentMcp(
  servers: NonNullable<AgentDefinition['mcpServers']>,
  sessionTools: Record<string, AnyTool> = {},
): Promise<AgentMcp> {
  const tools: Record<string, AnyTool> = {}
  let inline: Record<string, MCPServerConfig> = {}
  for (const entry of servers) {
    if (typeof entry !== 'string') {
      Object.assign(inline, entry)
      continue
    }
    const prefix = `${entry}_`
    const found = Object.entries(sessionTools).filter(([name]) =>
      name.startsWith(prefix),
    )
    if (found.length === 0) {
      console.warn(`[agents] MCP server '${entry}' is not connected`)
    }
    for (const [name, tool] of found) tools[name] = tool
  }

  // The rule session MCP follows (getMCPManagerForServers).
  if (isCloudWorkspacesEnabled()) {
    const filtered = filterHttpMCPServers(inline)
    inline = filtered.servers
    if (filtered.dropped.length > 0) {
      console.warn(
        `[agents] cloud runtime rejected non-HTTP servers: ${filtered.dropped.join(', ')}`,
      )
    }
  }
  if (Object.keys(inline).length === 0) {
    return { tools, close: async () => {} }
  }

  const manager = new MCPManager()
  await Promise.all(
    Object.entries(inline).map(([name, config]) =>
      manager.addServer(name, config),
    ),
  )
  return {
    tools: { ...tools, ...manager.getAllTools() },
    close: () => manager.closeAll(),
  }
}

/** The listed skills' instructions, as messages that open the conversation. */
export async function preloadSkillMessages(
  names: readonly string[],
  cwd: string,
): Promise<Message[]> {
  const { skills } = await loadSkillsFromDisk(cwd)
  const messages: Message[] = []
  for (const name of names) {
    const skill = skills.find(s => s.name === name)
    if (!skill) {
      console.warn(`[agents] skill '${name}' not found; not preloaded`)
      continue
    }
    try {
      const { combined } = await expandSkillBody(skill, '', cwd)
      messages.push({
        role: 'user',
        content: `<skill name="${name}">\n${combined}\n</skill>`,
        isMeta: true,
        uuid: randomUUID(),
      })
    } catch (err) {
      console.warn(
        `[agents] skill '${name}' could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return messages
}
