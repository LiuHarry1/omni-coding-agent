import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from '../../core/types.js'
import {
  getMCPManagerForServers,
  invalidateMCPManagersForCwd,
} from '../../services/mcp/lifecycle.js'
import {
  startFakeMcpServer,
  type FakeMcpServer,
} from '../../services/mcp/testing/fake-server.js'

const settings = vi.hoisted(() => ({
  servers: {} as Record<string, unknown>,
}))

vi.mock('../../utils/settings/manager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/settings/manager.js')>()),
  resolveEffectiveSettings: async () => ({
    effectiveMcpServers: settings.servers,
    mcpProvenance: {},
  }),
}))

const { handleMcpActions, handleMcpOAuthCallback, listMcpPromptEntries } =
  await import('./mcp.js')

let home: string
let server: FakeMcpServer

function servers(): Record<string, MCPServerConfig> {
  return settings.servers as Record<string, MCPServerConfig>
}

async function call(
  handler: typeof handleMcpActions,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ handled: boolean; status?: number; text: string }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:4567' }
  const out: { status?: number; text: string } = { text: '' }
  const res = {
    setHeader() {},
    writeHead(status: number) {
      out.status = status
    },
    end(chunk?: string) {
      out.text += chunk ?? ''
    },
  } as unknown as ServerResponse
  const handled = await handler(req, res)
  return { handled, ...out }
}

const post = (url: string, body: unknown) =>
  call(handleMcpActions, 'POST', `${url}?workspace=${home}`, body)

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-routes-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('AGENT_PUBLIC_URL', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  server = await startFakeMcpServer()
  settings.servers = { fake: { url: server.httpUrl, transport: 'http' } }
})

afterEach(async () => {
  invalidateMCPManagersForCwd(home)
  await server.close()
  fs.rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('MCP sign-in routes', () => {
  it('signs in through the browser round trip', async () => {
    server.requireToken('token-1')
    const manager = await getMCPManagerForServers(home, servers())
    expect(manager.getStatus()[0]?.status).toBe('needs-auth')

    const started = await post('/mcp/oauth/start', { name: 'fake' })
    expect(started.status).toBe(200)
    const { authorized, authorization_url } = JSON.parse(started.text)
    expect(authorized).toBe(false)
    const authorization = new URL(authorization_url)
    // Back to this server, at the address the request came in on.
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4567/mcp/oauth/callback',
    )

    const state = authorization.searchParams.get('state')!
    const landed = await call(
      handleMcpOAuthCallback,
      'GET',
      `/mcp/oauth/callback?code=the-code&state=${encodeURIComponent(state)}`,
    )
    expect(landed.status).toBe(200)
    expect(landed.text).toContain('Signed in to fake')
    // The server is usable by the time the page says so.
    expect(manager.getStatus()[0]).toMatchObject({
      status: 'connected',
      tools: ['echo'],
    })
  })

  it('sends the browser back to the public address when one is set', async () => {
    server.requireToken('token-1')
    vi.stubEnv('AGENT_PUBLIC_URL', 'https://agent.example.com/code/')

    const started = await post('/mcp/oauth/start', {
      name: 'fake',
      redirect_base: 'http://ignored.example.com',
    })
    expect(
      new URL(JSON.parse(started.text).authorization_url).searchParams.get(
        'redirect_uri',
      ),
    ).toBe('https://agent.example.com/code/mcp/oauth/callback')
  })

  it('uses the address the page reaches the API on otherwise', async () => {
    server.requireToken('token-1')

    const started = await post('/mcp/oauth/start', {
      name: 'fake',
      redirect_base: 'https://ui.example.com/code',
    })
    expect(
      new URL(JSON.parse(started.text).authorization_url).searchParams.get(
        'redirect_uri',
      ),
    ).toBe('https://ui.example.com/code/mcp/oauth/callback')
  })

  it('shows why a sign-in failed, without trusting what it is told', async () => {
    const denied = await call(
      handleMcpOAuthCallback,
      'GET',
      '/mcp/oauth/callback?error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E',
    )
    expect(denied.status).toBe(400)
    expect(denied.text).toContain('&lt;b&gt;no&lt;/b&gt;')
    expect(denied.text).not.toContain('<b>no</b>')

    const stale = await call(
      handleMcpOAuthCallback,
      'GET',
      '/mcp/oauth/callback?code=x&state=made-up',
    )
    expect(stale.status).toBe(400)
    expect(stale.text).toContain('expired')
  })

  it('only signs in to servers that exist and are remote', async () => {
    settings.servers = { local: { command: 'node' } }

    const unknown = await post('/mcp/oauth/start', { name: 'nope' })
    expect(unknown.status).toBe(404)

    const stdio = await post('/mcp/oauth/start', { name: 'local' })
    expect(stdio.status).toBe(400)
    expect(JSON.parse(stdio.text).error).toMatch(/HTTP and SSE/)
  })

  it('leaves other requests to the rest of the router', async () => {
    expect((await call(handleMcpActions, 'GET', '/mcp')).handled).toBe(false)
    expect(
      (await call(handleMcpOAuthCallback, 'GET', '/mcp?workspace=x')).handled,
    ).toBe(false)
  })
})

describe('MCP reconnect route', () => {
  it('reconnects a server and answers with the new status', async () => {
    server.requireToken('token-1')
    const manager = await getMCPManagerForServers(home, servers())
    expect(manager.getStatus()[0]?.status).toBe('needs-auth')

    server.requireToken(null)
    const result = await post('/mcp/reconnect', { name: 'fake' })

    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).servers).toEqual([
      {
        name: 'fake',
        status: 'connected',
        tools: ['echo'],
        resources: true,
        prompts: true,
      },
    ])
  })

  it('answers 404 for a server that is not configured', async () => {
    const result = await post('/mcp/reconnect', { name: 'nope' })
    expect(result.status).toBe(404)
  })
})

describe('MCP prompts in the slash menu', () => {
  it('lists the prompts of connected servers', async () => {
    expect(await listMcpPromptEntries(home)).toEqual([
      expect.objectContaining({
        name: 'mcp__fake__greet',
        kind: 'mcp-prompt',
        argumentHint: '<name> [tone]',
      }),
    ])
  })

  it('lists nothing when no server is configured', async () => {
    settings.servers = {}
    expect(await listMcpPromptEntries(home)).toEqual([])
  })
})
