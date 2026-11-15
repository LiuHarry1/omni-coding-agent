import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import type {
  AnyTool,
  MCPServerConfig,
  MCPServerStatus,
} from '../../core/types.js'
import { resolveAgentHome } from '../../utils/workspace/request-scope.js'
import { mcpCredentialsPath, storedMcpAuthProvider } from './oauth.js'
import {
  createServerTransport,
  isHttpServerConfig,
  isSessionExpiredError,
  isUnauthorizedError,
  TransportTap,
  type MCPServerCapabilities,
} from './transport.js'

export interface MCPReconnectPolicy {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
}

/** Claude Code's numbers: five attempts, 1 s doubling up to 30 s. */
const DEFAULT_RECONNECT: MCPReconnectPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
}

/** Servers page their lists; nobody needs more than this many pages. */
const MAX_LIST_PAGES = 20

export interface MCPResourceInfo {
  server: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export type MCPResourceContent = {
  uri: string
  mimeType?: string
} & ({ text: string } | { blob: string })

export interface MCPPromptInfo {
  server: string
  name: string
  description?: string
  arguments: { name: string; description?: string; required?: boolean }[]
}

export type MCPPromptMessage = Awaited<
  ReturnType<MCPClient['experimental_getPrompt']>
>['messages'][number]

interface Connection {
  client: MCPClient
}

interface ManagedServer {
  name: string
  config: MCPServerConfig
  /** Where this server's OAuth credentials are kept; remote servers only. */
  credentialsFile?: string
  connection: Connection | null
  tools: Record<string, AnyTool>
  capabilities: MCPServerCapabilities
  status: MCPServerStatus
  /** Settles when the reconnect in progress has succeeded or given up. */
  recovering: Promise<void> | null
  prompts: MCPPromptInfo[] | null
  removed: boolean
  /** Ends the wait between reconnect attempts. */
  wake?: () => void
}

const NO_CAPABILITIES: MCPServerCapabilities = {
  tools: false,
  resources: false,
  prompts: false,
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hasStaticAuthorization(config: MCPServerConfig): boolean {
  if (!isHttpServerConfig(config)) return false
  return Object.keys(config.headers ?? {}).some(
    name => name.toLowerCase() === 'authorization',
  )
}

export class MCPManager {
  #servers = new Map<string, ManagedServer>()
  #reconnect: MCPReconnectPolicy
  #agentHome: string | undefined

  constructor(
    options: {
      reconnect?: Partial<MCPReconnectPolicy>
      /** Where OAuth credentials are kept; the request's user by default. */
      agentHome?: string
    } = {},
  ) {
    this.#reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect }
    this.#agentHome = options.agentHome
  }

  /** Add and connect a single MCP server. */
  async addServer(name: string, config: MCPServerConfig): Promise<void> {
    if (this.#servers.has(name)) {
      await this.removeServer(name)
    }

    const managed: ManagedServer = {
      name,
      config,
      // Resolved now: reconnects run outside the request that added the server.
      credentialsFile: isHttpServerConfig(config)
        ? mcpCredentialsPath(
            resolveAgentHome(this.#agentHome),
            name,
            config.url,
          )
        : undefined,
      connection: null,
      tools: {},
      capabilities: NO_CAPABILITIES,
      status: { name, status: 'disconnected', tools: [] },
      recovering: null,
      prompts: null,
      removed: false,
    }
    this.#servers.set(name, managed)
    await this.#open(managed)
  }

  /** Disconnect and remove a server. */
  async removeServer(name: string): Promise<void> {
    const managed = this.#servers.get(name)
    if (!managed) return
    managed.removed = true
    managed.wake?.()
    this.#servers.delete(name)
    await this.#retire(managed)
    console.log(`[mcp] Removed server: ${name}`)
  }

  /**
   * Drop the current connection and connect again: after a sign-in, or when
   * the user asks for it.
   */
  async reconnect(name: string): Promise<void> {
    const managed = this.#servers.get(name)
    if (!managed) return
    if (managed.recovering) return managed.recovering
    await this.#retire(managed)
    managed.tools = {}
    await this.#open(managed)
  }

  /** Reconnect the servers waiting on the credentials in `file`. */
  async reconnectWithCredentials(file: string): Promise<void> {
    const waiting = [...this.#servers.values()].filter(
      managed =>
        managed.credentialsFile === file &&
        managed.status.status !== 'connected',
    )
    await Promise.all(waiting.map(managed => this.reconnect(managed.name)))
  }

  /**
   * All MCP tools in one record, prefixed with the server name. A tool is
   * bound to its server, not to one connection, so a turn that started before
   * a reconnect keeps working after it.
   */
  getAllTools(): Record<string, AnyTool> {
    const all: Record<string, AnyTool> = {}
    for (const [serverName, managed] of this.#servers) {
      const { status } = managed.status
      if (status !== 'connected' && status !== 'reconnecting') continue
      for (const [toolName, tool] of Object.entries(managed.tools)) {
        all[`${serverName}_${toolName}`] = this.#bindTool(
          managed,
          toolName,
          tool,
        )
      }
    }
    return all
  }

  /** Get status of all servers. */
  getStatus(): MCPServerStatus[] {
    return [...this.#servers.values()].map(m => m.status)
  }

  /** True when a connected server offers resources. */
  hasResources(): boolean {
    return this.#offering('resources').length > 0
  }

  /** The names of the servers that are connected right now. */
  connectedServerNames(): string[] {
    return [...this.#servers.values()]
      .filter(managed => managed.status.status === 'connected')
      .map(managed => managed.name)
  }

  /** Resources of one server, or of every server that offers them. */
  async listResources(server?: string): Promise<MCPResourceInfo[]> {
    const targets = server
      ? [this.#requireOffering(server, 'resources')]
      : this.#offering('resources')
    const lists = await Promise.all(
      targets.map(async managed => {
        try {
          return await this.#listServerResources(managed)
        } catch (err) {
          // One broken server must not hide what the others have.
          if (server) throw err
          console.warn(
            `[mcp] ${managed.name}: listing resources failed: ${errorMessage(err)}`,
          )
          return []
        }
      }),
    )
    return lists.flat()
  }

  async readResource(
    server: string,
    uri: string,
  ): Promise<MCPResourceContent[]> {
    const managed = this.#requireOffering(server, 'resources')
    const result = await this.#run(managed, ({ client }) =>
      client.readResource({ uri }),
    )
    return result.contents as MCPResourceContent[]
  }

  /** Prompts of every connected server that offers them. */
  async listPrompts(): Promise<MCPPromptInfo[]> {
    const lists = await Promise.all(
      this.#offering('prompts').map(async managed => {
        if (managed.prompts) return managed.prompts
        try {
          const prompts = await this.#listServerPrompts(managed)
          managed.prompts = prompts
          return prompts
        } catch (err) {
          console.warn(
            `[mcp] ${managed.name}: listing prompts failed: ${errorMessage(err)}`,
          )
          return []
        }
      }),
    )
    return lists.flat()
  }

  async getPrompt(
    server: string,
    name: string,
    args: Record<string, string>,
  ): Promise<MCPPromptMessage[]> {
    const managed = this.#requireOffering(server, 'prompts')
    const result = await this.#run(managed, ({ client }) =>
      client.experimental_getPrompt({ name, arguments: args }),
    )
    return result.messages
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

  // ── Connection ──────────────────────────────────

  /** Connect and record the outcome in the server's status. */
  async #open(managed: ManagedServer): Promise<boolean> {
    try {
      await this.#connect(managed)
      return true
    } catch (err) {
      if (managed.removed) return false
      managed.status = this.#failureStatus(managed, err)
      console.error(`[mcp] ✗ ${managed.name}: ${errorMessage(err)}`)
      return false
    }
  }

  #failureStatus(managed: ManagedServer, err: unknown): MCPServerStatus {
    const { name } = managed
    if (this.#needsSignIn(managed, err)) {
      return {
        name,
        status: 'needs-auth',
        tools: [],
        error: 'This server needs you to sign in.',
      }
    }
    return { name, status: 'error', tools: [], error: errorMessage(err) }
  }

  /** A 401 we can do something about: a remote server without a fixed token. */
  #needsSignIn(managed: ManagedServer, err: unknown): boolean {
    return (
      isHttpServerConfig(managed.config) &&
      !hasStaticAuthorization(managed.config) &&
      isUnauthorizedError(err)
    )
  }

  async #connect(managed: ManagedServer): Promise<void> {
    const { name, config } = managed
    const remote = isHttpServerConfig(config)
    const authProvider =
      remote && managed.credentialsFile && !hasStaticAuthorization(config)
        ? storedMcpAuthProvider(managed.credentialsFile, config)
        : undefined

    const capabilities = { ...NO_CAPABILITIES }
    let connection: Connection | null = null
    const live = () => connection !== null && managed.connection === connection

    const transport = new TransportTap(
      createServerTransport(config, authProvider),
      {
        onCapabilities: found => Object.assign(capabilities, found),
        onNotification: method => {
          if (live()) this.#onNotification(managed, connection!, method)
        },
        onClose: () => {
          if (live()) void this.#recover(managed, connection!)
        },
      },
      { remote },
    )

    const client = await createMCPClient({ transport })
    let tools: Record<string, AnyTool> = {}
    try {
      // The client refuses to list tools for a server that has none.
      if (capabilities.tools) {
        tools = (await client.tools()) as Record<string, AnyTool>
      }
    } catch (err) {
      await client.close().catch(() => {})
      throw err
    }
    if (managed.removed) {
      await client.close().catch(() => {})
      return
    }

    connection = { client }
    managed.connection = connection
    managed.tools = tools
    managed.capabilities = capabilities
    managed.prompts = null
    const toolNames = Object.keys(tools)
    managed.status = {
      name,
      status: 'connected',
      tools: toolNames,
      resources: capabilities.resources,
      prompts: capabilities.prompts,
    }
    console.log(
      `[mcp] ✓ ${name}: ${toolNames.length} tools (${toolNames.join(', ')})`,
    )
  }

  /** Close the current connection without setting off a reconnect. */
  async #retire(managed: ManagedServer): Promise<void> {
    const connection = managed.connection
    managed.connection = null
    try {
      await connection?.client.close()
    } catch {}
  }

  /**
   * `connection` is gone without our asking. Try to get the server back;
   * callers that need it wait on the returned promise.
   */
  #recover(managed: ManagedServer, connection: Connection): Promise<void> {
    if (managed.removed) return Promise.resolve()
    // Someone else noticed first.
    if (managed.connection !== connection) {
      return managed.recovering ?? Promise.resolve()
    }

    managed.connection = null
    managed.status = { ...managed.status, status: 'reconnecting' }
    void connection.client.close().catch(() => {})
    console.warn(`[mcp] ${managed.name}: connection lost, reconnecting`)

    const { maxAttempts, initialDelayMs, maxDelayMs } = this.#reconnect
    const run = (async () => {
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          await this.#pause(
            managed,
            Math.min(initialDelayMs * 2 ** (attempt - 2), maxDelayMs),
          )
        }
        if (managed.removed) return
        try {
          await this.#connect(managed)
          return
        } catch (err) {
          lastError = err
          if (this.#needsSignIn(managed, err)) break
          console.warn(
            `[mcp] ${managed.name}: reconnect attempt ${attempt}/${maxAttempts} failed: ${errorMessage(err)}`,
          )
        }
      }
      if (managed.removed) return
      managed.tools = {}
      const failure = this.#failureStatus(managed, lastError)
      managed.status =
        failure.status === 'error'
          ? {
              ...failure,
              error: `Connection lost and could not be re-established: ${failure.error}`,
            }
          : failure
      console.error(`[mcp] ✗ ${managed.name}: ${managed.status.error}`)
    })().finally(() => {
      if (managed.recovering === run) managed.recovering = null
    })
    managed.recovering = run
    return run
  }

  #pause(managed: ManagedServer, ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        managed.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      managed.wake = done
    })
  }

  #onNotification(
    managed: ManagedServer,
    connection: Connection,
    method: string,
  ): void {
    if (method === 'notifications/tools/list_changed') {
      void this.#refreshTools(managed, connection)
    } else if (method === 'notifications/prompts/list_changed') {
      managed.prompts = null
    }
    // Resources are listed on demand, so there is nothing to refresh.
  }

  /** The server changed its tools. Turns that start from here on see them. */
  async #refreshTools(
    managed: ManagedServer,
    connection: Connection,
  ): Promise<void> {
    try {
      const tools = (await connection.client.tools()) as Record<string, AnyTool>
      if (managed.connection !== connection) return
      managed.tools = tools
      const toolNames = Object.keys(tools)
      managed.status = { ...managed.status, tools: toolNames }
      console.log(
        `[mcp] ${managed.name}: tool list changed, now ${toolNames.length} tools`,
      )
    } catch (err) {
      console.warn(
        `[mcp] ${managed.name}: refreshing tools failed: ${errorMessage(err)}`,
      )
    }
  }

  // ── Calls ───────────────────────────────────────

  /**
   * Run `action` on the server's current connection, waiting out a reconnect
   * in progress. If the server has forgotten our session the call never
   * reached it, so it is repeated once on a fresh connection.
   */
  async #run<T>(
    managed: ManagedServer,
    action: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    for (let retried = false; ; retried = true) {
      if (managed.recovering) await managed.recovering
      const connection = managed.connection
      if (!connection) {
        const reason = managed.status.error ? `: ${managed.status.error}` : ''
        throw new Error(
          `MCP server '${managed.name}' is not connected${reason}`,
        )
      }
      try {
        return await action(connection)
      } catch (err) {
        if (retried || !isSessionExpiredError(err)) throw err
        await this.#recover(managed, connection)
      }
    }
  }

  #bindTool(managed: ManagedServer, toolName: string, tool: AnyTool): AnyTool {
    if (typeof (tool as { execute?: unknown }).execute !== 'function') {
      return tool
    }
    const execute = (args: unknown, options: unknown) =>
      this.#run(managed, async () => {
        const current = managed.tools[toolName] as
          { execute?: (args: unknown, options: unknown) => unknown } | undefined
        if (typeof current?.execute !== 'function') {
          throw new Error(
            `MCP server '${managed.name}' no longer offers the tool '${toolName}'`,
          )
        }
        return current.execute(args, options)
      })
    return { ...tool, execute } as AnyTool
  }

  #offering(capability: 'resources' | 'prompts'): ManagedServer[] {
    return [...this.#servers.values()].filter(
      managed =>
        managed.status.status === 'connected' &&
        managed.capabilities[capability],
    )
  }

  #requireOffering(
    server: string,
    capability: 'resources' | 'prompts',
  ): ManagedServer {
    const managed = this.#servers.get(server)
    if (!managed) {
      const names = [...this.#servers.keys()].join(', ') || 'none'
      throw new Error(
        `Server "${server}" not found. Available servers: ${names}`,
      )
    }
    const { status } = managed.status
    if (status !== 'connected' && status !== 'reconnecting') {
      throw new Error(`Server "${server}" is not connected`)
    }
    if (!managed.capabilities[capability]) {
      throw new Error(`Server "${server}" does not support ${capability}`)
    }
    return managed
  }

  async #listServerResources(
    managed: ManagedServer,
  ): Promise<MCPResourceInfo[]> {
    const found: MCPResourceInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.#run(managed, ({ client }) =>
        client.listResources(cursor ? { params: { cursor } } : undefined),
      )
      for (const resource of result.resources) {
        found.push({
          server: managed.name,
          uri: resource.uri,
          name: resource.name,
          ...(resource.description
            ? { description: resource.description }
            : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        })
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
    return found
  }

  async #listServerPrompts(managed: ManagedServer): Promise<MCPPromptInfo[]> {
    const found: MCPPromptInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.#run(managed, ({ client }) =>
        client.experimental_listPrompts(
          cursor ? { params: { cursor } } : undefined,
        ),
      )
      for (const prompt of result.prompts) {
        found.push({
          server: managed.name,
          name: prompt.name,
          ...(prompt.description ? { description: prompt.description } : {}),
          arguments: (prompt.arguments ?? []).map(argument => ({
            name: argument.name,
            ...(argument.description
              ? { description: argument.description }
              : {}),
            ...(argument.required ? { required: true } : {}),
          })),
        })
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
    return found
  }
}
