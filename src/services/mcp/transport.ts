/**
 * Transports for MCP servers, and the tap that sits between a transport and
 * the AI SDK client.
 *
 * The AI SDK client converts tools well but ignores everything a server says
 * on its own: notifications are reported as errors, and a dropped connection
 * is never noticed. The tap reads those off the wire before the client sees
 * them.
 */
import type { MCPTransport } from '@ai-sdk/mcp'
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { MCPServerConfig, MCPServerHTTP } from '../../core/types.js'

type JSONRPCMessage = Parameters<MCPTransport['send']>[0]

export interface MCPServerCapabilities {
  tools: boolean
  resources: boolean
  prompts: boolean
}

export interface TransportTapEvents {
  /** The server answered `initialize`. */
  onCapabilities?: (capabilities: MCPServerCapabilities) => void
  /** A notification from the server, e.g. `notifications/tools/list_changed`. */
  onNotification?: (method: string) => void
  /** The connection is gone, whoever closed it. */
  onClose?: () => void
  onError?: (error: Error) => void
}

export function isHttpServerConfig(
  config: MCPServerConfig,
): config is MCPServerHTTP {
  return !('command' in config)
}

export function createServerTransport(
  config: MCPServerConfig,
  authProvider?: OAuthClientProvider,
): Transport {
  if (!isHttpServerConfig(config)) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    })
  }
  const url = new URL(config.url)
  const options = {
    authProvider,
    requestInit: config.headers ? { headers: config.headers } : undefined,
  }
  return (config.transport ?? 'sse') === 'http'
    ? new StreamableHTTPClientTransport(url, options)
    : new SSEClientTransport(url, options)
}

/**
 * The server no longer knows our session: HTTP 404 carrying JSON-RPC -32001.
 * Both are checked so a plain 404 (wrong URL) is not taken for one.
 */
export function isSessionExpiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as Error & { code?: unknown }).code !== 404) return false
  return /"code":\s*-32001/.test(error.message)
}

/** The server refused our credentials (or the lack of them). */
export function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  if (!(error instanceof Error)) return false
  if ((error as Error & { code?: unknown }).code === 401) return true
  return /\bHTTP 401\b|\b401 Unauthorized\b/i.test(error.message)
}

const TERMINAL_ERROR_MARKERS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'Body Timeout Error',
  'terminated',
  'SSE stream disconnected',
  'Failed to reconnect SSE stream',
]
const TERMINAL_ERRORS_BEFORE_CLOSE = 3

export class TransportTap implements MCPTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  #inner: Transport
  #events: TransportTapEvents
  #remote: boolean
  #terminalErrors = 0
  #closed = false

  constructor(
    inner: Transport,
    events: TransportTapEvents,
    opts: { remote: boolean },
  ) {
    this.#inner = inner
    this.#events = events
    this.#remote = opts.remote

    inner.onmessage = message => this.#receive(message as JSONRPCMessage)
    inner.onerror = error => this.#fail(error)
    inner.onclose = () => {
      if (this.#closed) return
      this.#closed = true
      this.onclose?.()
      this.#events.onClose?.()
    }
  }

  start(): Promise<void> {
    return this.#inner.start()
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.#inner.send(message as Parameters<Transport['send']>[0])
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion?.(version)
  }

  #receive(message: JSONRPCMessage): void {
    const record = message as Record<string, unknown>
    if (typeof record.method === 'string' && !('id' in record)) {
      // The client has no use for notifications and reports each as an error.
      this.#events.onNotification?.(record.method)
      return
    }
    const result = record.result as
      { protocolVersion?: unknown; capabilities?: unknown } | undefined
    if (
      result &&
      typeof result.protocolVersion === 'string' &&
      result.capabilities &&
      typeof result.capabilities === 'object'
    ) {
      const capabilities = result.capabilities as Record<string, unknown>
      this.#events.onCapabilities?.({
        tools: capabilities.tools != null,
        resources: capabilities.resources != null,
        prompts: capabilities.prompts != null,
      })
    }
    this.onmessage?.(message)
  }

  /**
   * The remote transports report a lost connection as an error and stay
   * "open", so calls in flight would hang. Closing here rejects them and lets
   * the owner reconnect.
   */
  #fail(error: Error): void {
    this.onerror?.(error)
    this.#events.onError?.(error)
    if (!this.#remote || this.#closed) return

    const message = error.message ?? ''
    const gaveUp =
      isSessionExpiredError(error) ||
      message.includes('Maximum reconnection attempts')
    if (!gaveUp) {
      if (!TERMINAL_ERROR_MARKERS.some(marker => message.includes(marker))) {
        this.#terminalErrors = 0
        return
      }
      this.#terminalErrors += 1
      if (this.#terminalErrors < TERMINAL_ERRORS_BEFORE_CLOSE) return
    }
    this.#terminalErrors = 0
    // After the failing call has rejected with its own error, which says more
    // than the "connection closed" every pending call gets from the close.
    setImmediate(() => {
      if (!this.#closed) void this.#inner.close().catch(() => {})
    })
  }
}
