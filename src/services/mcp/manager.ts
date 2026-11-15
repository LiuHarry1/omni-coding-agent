import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  AnyTool,
  MCPServerConfig,
  MCPServerStatus,
} from '../../core/types.js'

interface ManagedServer {
  name: string
  config: MCPServerConfig
  client: MCPClient | null
  tools: Record<string, AnyTool>
  status: MCPServerStatus
}

function isStdio(
  c: MCPServerConfig,
): c is { command: string; args?: string[]; env?: Record<string, string> } {
  return 'command' in c
}

export class MCPManager {
  #servers = new Map<string, ManagedServer>()

  /** Add and connect a single MCP server. */
  async addServer(name: string, config: MCPServerConfig): Promise<void> {
    if (this.#servers.has(name)) {
      await this.removeServer(name)
    }

    const managed: ManagedServer = {
      name,
      config,
      client: null,
      tools: {},
      status: { name, status: 'disconnected', tools: [] },
    }
    this.#servers.set(name, managed)

    try {
      const transport = isStdio(config)
        ? new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: { ...process.env, ...(config.env ?? {}) } as Record<
              string,
              string
            >,
          })
        : {
            type: (config.transport ?? 'sse') as 'sse' | 'http',
            url: config.url,
            headers: config.headers,
          }

      managed.client = await createMCPClient({ transport })
      managed.tools = (await managed.client.tools()) as Record<string, AnyTool>

      const toolNames = Object.keys(managed.tools)
      managed.status = { name, status: 'connected', tools: toolNames }
      console.log(
        `[mcp] ✓ ${name}: ${toolNames.length} tools (${toolNames.join(', ')})`,
      )
    } catch (err: any) {
      managed.status = { name, status: 'error', tools: [], error: err.message }
      console.error(`[mcp] ✗ ${name}: ${err.message}`)
    }
  }

  /** Disconnect and remove a server. */
  async removeServer(name: string): Promise<void> {
    const managed = this.#servers.get(name)
    if (!managed) return
    try {
      await managed.client?.close()
    } catch {}
    this.#servers.delete(name)
    console.log(`[mcp] Removed server: ${name}`)
  }

  /** Get all MCP tools merged into a single record (prefixed with server name). */
  getAllTools(): Record<string, AnyTool> {
    const all: Record<string, AnyTool> = {}
    for (const [serverName, managed] of this.#servers) {
      if (managed.status.status !== 'connected') continue
      for (const [toolName, tool] of Object.entries(managed.tools)) {
        all[`${serverName}_${toolName}`] = tool
      }
    }
    return all
  }

  /** Get status of all servers. */
  getStatus(): MCPServerStatus[] {
    return [...this.#servers.values()].map(m => m.status)
  }

  /** Gracefully close all connections. */
  async closeAll(): Promise<void> {
    const closing = [...this.#servers.keys()].map(name =>
      this.removeServer(name),
    )
    await Promise.allSettled(closing)
  }

  get serverCount(): number {
    return this.#servers.size
  }

  get connectedCount(): number {
    return [...this.#servers.values()].filter(
      m => m.status.status === 'connected',
    ).length
  }
}
