/**
 * A real MCP server for tests, over streamable HTTP and SSE, with an OAuth
 * authorization server next to it. Built on the official SDK so the client is
 * tested against the protocol, not against a mock of it.
 */
import { randomUUID } from 'crypto'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export interface FakeMcpServerOptions {
  /** Leave the tools capability out, as a resources-only server would. */
  withoutTools?: boolean
  /** Listen here instead of on a free port. */
  port?: number
}

export interface FakeMcpServer {
  origin: string
  /** Streamable HTTP endpoint. */
  httpUrl: string
  /** SSE endpoint. */
  sseUrl: string
  /** The arguments `echo` was called with, in order. */
  echoed: string[]
  /** Add a tool to every live session; they are told the list changed. */
  addTool(name: string): void
  /** Forget every streamable-HTTP session, as a restarted server would. */
  forgetSessions(): Promise<void>
  /** Require `Authorization: Bearer <token>`; null turns the check off. */
  requireToken(token: string | null): void
  oauth: {
    /** How many clients registered themselves. */
    registrations: number
    /** The bodies of the token requests received. */
    tokenRequests: URLSearchParams[]
    /** Answer refresh requests with `invalid_grant`. */
    refuseRefresh: boolean
    /** The access token the next token response carries. */
    nextAccessToken: string
  }
  close(): Promise<void>
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeMcpServer(
  options: FakeMcpServerOptions = {},
): Promise<FakeMcpServer> {
  const echoed: string[] = []
  const extraTools: string[] = []
  const live = new Set<McpServer>()
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const sseSessions = new Map<string, SSEServerTransport>()
  let requiredToken: string | null = null
  const oauth: FakeMcpServer['oauth'] = {
    registrations: 0,
    tokenRequests: [],
    refuseRefresh: false,
    nextAccessToken: 'token-1',
  }

  const registerExtraTool = (server: McpServer, name: string) => {
    server.registerTool(name, { description: `Added later: ${name}` }, () => ({
      content: [{ type: 'text', text: name }],
    }))
  }

  const buildServer = (): McpServer => {
    const server = new McpServer({ name: 'fake', version: '1.0.0' })
    if (!options.withoutTools) {
      server.registerTool(
        'echo',
        { description: 'Say it back', inputSchema: { text: z.string() } },
        ({ text }) => {
          echoed.push(text)
          return { content: [{ type: 'text', text: `echo: ${text}` }] }
        },
      )
      for (const name of extraTools) registerExtraTool(server, name)
    }
    server.registerResource(
      'note',
      'memo://note',
      { description: 'A short note', mimeType: 'text/plain' },
      uri => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'remember' }],
      }),
    )
    server.registerResource(
      'pixel',
      'memo://pixel',
      { mimeType: 'image/png' },
      uri => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'image/png',
            blob: Buffer.from('not really a png').toString('base64'),
          },
        ],
      }),
    )
    server.registerPrompt(
      'greet',
      {
        description: 'Greet someone',
        argsSchema: { name: z.string(), tone: z.string().optional() },
      },
      ({ name, tone }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Say hello to ${name}${tone ? ` in a ${tone} tone` : ''}.`,
            },
          },
        ],
      }),
    )
    live.add(server)
    server.server.onclose = () => live.delete(server)
    return server
  }

  let origin = ''

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', origin)
    const route = url.pathname

    // ── OAuth authorization server ────────────────
    if (route.startsWith('/.well-known/oauth-protected-resource')) {
      sendJSON(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      })
      return
    }
    if (route.startsWith('/.well-known/oauth-authorization-server')) {
      sendJSON(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (route.startsWith('/.well-known/')) {
      sendJSON(res, 404, { error: 'not_found' })
      return
    }
    if (route === '/authorize') {
      // A provider whose user always says yes: straight back with a code.
      const back = new URL(url.searchParams.get('redirect_uri') ?? origin)
      back.searchParams.set('code', 'approved')
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      res.writeHead(302, { location: back.href })
      res.end()
      return
    }
    if (route === '/register' && req.method === 'POST') {
      oauth.registrations += 1
      const metadata = JSON.parse(await readBody(req)) as object
      sendJSON(res, 201, {
        ...metadata,
        client_id: `client-${oauth.registrations}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      })
      return
    }
    if (route === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      oauth.tokenRequests.push(form)
      if (form.get('grant_type') === 'refresh_token' && oauth.refuseRefresh) {
        sendJSON(res, 400, { error: 'invalid_grant' })
        return
      }
      sendJSON(res, 200, {
        access_token: oauth.nextAccessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
      })
      return
    }

    // ── MCP ───────────────────────────────────────
    if (
      requiredToken !== null &&
      req.headers.authorization !== `Bearer ${requiredToken}`
    ) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (route === '/mcp') {
      const sessionId = req.headers['mcp-session-id']
      if (typeof sessionId === 'string') {
        const transport = sessions.get(sessionId)
        if (!transport) {
          sendJSON(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          })
          return
        }
        await transport.handleRequest(req, res)
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          sessions.set(id, transport)
        },
      })
      await buildServer().connect(transport)
      await transport.handleRequest(req, res)
      return
    }

    if (route === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res)
      sseSessions.set(transport.sessionId, transport)
      res.on('close', () => sseSessions.delete(transport.sessionId))
      await buildServer().connect(transport)
      return
    }
    if (route === '/messages' && req.method === 'POST') {
      const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '')
      if (!transport) {
        sendJSON(res, 404, { error: 'unknown session' })
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    sendJSON(res, 404, { error: 'not_found' })
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) sendJSON(res, 500, { error: String(err) })
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`

  const closeSessions = async () => {
    const open = [...sessions.values(), ...sseSessions.values()]
    sessions.clear()
    sseSessions.clear()
    await Promise.allSettled(open.map(transport => transport.close()))
  }

  return {
    origin,
    httpUrl: `${origin}/mcp`,
    sseUrl: `${origin}/sse`,
    echoed,
    addTool(name) {
      extraTools.push(name)
      for (const server of live) registerExtraTool(server, name)
    },
    async forgetSessions() {
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(open.map(transport => transport.close()))
    },
    requireToken(token) {
      requiredToken = token
    },
    oauth,
    async close() {
      await closeSessions()
      httpServer.closeAllConnections()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    },
  }
}
