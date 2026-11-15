import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnyTool } from '../../core/types.js'
import { MCPManager } from './manager.js'
import {
  finishMcpOAuthFlow,
  hasMcpTokens,
  mcpCredentialsPath,
  startMcpOAuthFlow,
} from './oauth.js'
import {
  startFakeMcpServer,
  type FakeMcpServer,
} from './testing/fake-server.js'

const STDIO_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testing',
  'stdio-server.mjs',
)
const FAST = { initialDelayMs: 5, maxDelayMs: 20 }
const REDIRECT = 'http://localhost:4567/mcp/oauth/callback'

let home: string
let server: FakeMcpServer | undefined
let manager: MCPManager | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-manager-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await manager?.closeAll()
  await server?.close()
  manager = undefined
  server = undefined
  fs.rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function newManager(reconnect = {}): MCPManager {
  manager = new MCPManager({
    agentHome: home,
    reconnect: { ...FAST, ...reconnect },
  })
  return manager
}

async function call(tool: AnyTool | undefined, args: object = {}) {
  const execute = (
    tool as unknown as {
      execute: (args: object, options: object) => Promise<unknown>
    }
  ).execute
  return JSON.stringify(await execute(args, { toolCallId: 't1', messages: [] }))
}

function statusOf(name: string) {
  return manager!.getStatus().find(status => status.name === name)
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('MCPManager connections', () => {
  it('connects over streamable HTTP and reports what the server offers', async () => {
    server = await startFakeMcpServer()
    const mcp = newManager()
    await mcp.addServer('fake', { url: server.httpUrl, transport: 'http' })

    expect(statusOf('fake')).toEqual({
      name: 'fake',
      status: 'connected',
      tools: ['echo'],
      resources: true,
      prompts: true,
    })
    expect(await call(mcp.getAllTools().fake_echo, { text: 'hi' })).toContain(
      'echo: hi',
    )
  })

  it('connects over SSE, the default for a URL', async () => {
    server = await startFakeMcpServer()
    const mcp = newManager()
    await mcp.addServer('fake', { url: server.sseUrl })

    expect(statusOf('fake')?.status).toBe('connected')
    expect(await call(mcp.getAllTools().fake_echo, { text: 'sse' })).toContain(
      'echo: sse',
    )
  })

  it('connects to a server that has no tools', async () => {
    server = await startFakeMcpServer({ withoutTools: true })
    const mcp = newManager()
    await mcp.addServer('fake', { url: server.httpUrl, transport: 'http' })

    expect(statusOf('fake')).toMatchObject({
      status: 'connected',
      tools: [],
      resources: true,
    })
    expect(mcp.getAllTools()).toEqual({})
  })

  it('picks up tools the server adds while connected', async () => {
    server = await startFakeMcpServer()
    const mcp = newManager()
    await mcp.addServer('fake', { url: server.httpUrl, transport: 'http' })

    server.addTool('later')
    await until(() => statusOf('fake')!.tools.includes('later'), 'the new tool')

    expect(await call(mcp.getAllTools().fake_later)).toContain('later')
  })

  it('reports a server it cannot reach as an error', async () => {
    const mcp = newManager()
    await mcp.addServer('gone', {
      url: 'http://127.0.0.1:9/mcp',
      transport: 'http',
    })

    expect(statusOf('gone')?.status).toBe('error')
    expect(mcp.getAllTools()).toEqual({})
  })
})

describe('MCPManager reconnecting', () => {
  it('repeats a call once when the server has forgotten the session', async () => {
    server = await startFakeMcpServer()
    const mcp = newManager()
    await mcp.addServer('fake', { url: server.httpUrl, transport: 'http' })
    // The tool a turn was handed before the session went away.
    const echo = mcp.getAllTools().fake_echo

    await server.forgetSessions()

    expect(await call(echo, { text: 'again' })).toContain('echo: again')
    expect(server.echoed).toEqual(['again'])
    expect(statusOf('fake')?.status).toBe('connected')
  })

  it('starts a stdio server again when it dies', async () => {
    const mcp = newManager()
    await mcp.addServer('local', {
      command: process.execPath,
      args: [STDIO_SERVER],
    })
    const tools = mcp.getAllTools()
    const firstPid = await call(tools.local_pid)

    await expect(call(tools.local_crash)).rejects.toThrow()
    await until(
      () => statusOf('local')?.status === 'connected',
      'the reconnect',
    )

    // Same tool object as before the crash, new process behind it.
    const secondPid = await call(tools.local_pid)
    expect(secondPid).not.toBe(firstPid)
  })

  it('makes a call that arrives mid-reconnect wait for it', async () => {
    const mcp = newManager({ initialDelayMs: 50 })
    await mcp.addServer('local', {
      command: process.execPath,
      args: [STDIO_SERVER],
    })
    const tools = mcp.getAllTools()

    await expect(call(tools.local_crash)).rejects.toThrow()
    await until(
      () => statusOf('local')?.status !== 'connected',
      'the drop to be noticed',
    )

    expect(await call(tools.local_pid)).toMatch(/\d+/)
  })

  it('gives up after the configured attempts and says why', async () => {
    const down = path.join(home, 'down')
    const mcp = newManager({ maxAttempts: 2 })
    await mcp.addServer('local', {
      command: process.execPath,
      args: [STDIO_SERVER],
      env: { MCP_TEST_DOWN: down },
    })
    const tools = mcp.getAllTools()

    fs.writeFileSync(down, '')
    await expect(call(tools.local_crash)).rejects.toThrow()
    await until(() => statusOf('local')?.status === 'error', 'giving up')

    expect(statusOf('local')?.error).toMatch(
      /Connection lost and could not be re-established/,
    )
    expect(mcp.getAllTools()).toEqual({})
    await expect(call(tools.local_pid)).rejects.toThrow(/is not connected/)
  })

  it('connects again on request', async () => {
    const down = path.join(home, 'down')
    fs.writeFileSync(down, '')
    const mcp = newManager()
    await mcp.addServer('local', {
      command: process.execPath,
      args: [STDIO_SERVER],
      env: { MCP_TEST_DOWN: down },
    })
    expect(statusOf('local')?.status).toBe('error')

    fs.rmSync(down)
    await mcp.reconnect('local')

    expect(statusOf('local')).toMatchObject({
      status: 'connected',
      tools: ['pid', 'crash'],
    })
  })

  it('stops reconnecting a server that was removed', async () => {
    const down = path.join(home, 'down')
    const mcp = newManager({ initialDelayMs: 10_000 })
    await mcp.addServer('local', {
      command: process.execPath,
      args: [STDIO_SERVER],
      env: { MCP_TEST_DOWN: down },
    })
    fs.writeFileSync(down, '')
    await expect(call(mcp.getAllTools().local_crash)).rejects.toThrow()
    await until(
      () => statusOf('local')?.status === 'reconnecting',
      'the drop to be noticed',
    )

    // Returns at once although the next attempt is ten seconds away.
    await mcp.removeServer('local')
    expect(mcp.getStatus()).toEqual([])
  })
})

describe('MCPManager resources and prompts', () => {
  beforeEach(async () => {
    server = await startFakeMcpServer()
    await newManager().addServer('fake', {
      url: server.httpUrl,
      transport: 'http',
    })
  })

  it('lists resources with the server they belong to', async () => {
    expect(manager!.hasResources()).toBe(true)
    expect(await manager!.listResources()).toEqual([
      {
        server: 'fake',
        uri: 'memo://note',
        name: 'note',
        description: 'A short note',
        mimeType: 'text/plain',
      },
      {
        server: 'fake',
        uri: 'memo://pixel',
        name: 'pixel',
        mimeType: 'image/png',
      },
    ])
  })

  it('reads a resource', async () => {
    expect(await manager!.readResource('fake', 'memo://note')).toEqual([
      { uri: 'memo://note', mimeType: 'text/plain', text: 'remember' },
    ])
  })

  it('names the servers there are when asked for one there is not', async () => {
    await expect(manager!.listResources('nope')).rejects.toThrow(
      'Server "nope" not found. Available servers: fake',
    )
    await expect(manager!.readResource('nope', 'memo://note')).rejects.toThrow(
      /not found/,
    )
  })

  it('lists prompts with their arguments and expands one', async () => {
    expect(await manager!.listPrompts()).toEqual([
      {
        server: 'fake',
        name: 'greet',
        description: 'Greet someone',
        arguments: [{ name: 'name', required: true }, { name: 'tone' }],
      },
    ])

    const messages = await manager!.getPrompt('fake', 'greet', {
      name: 'Ada',
    })
    expect(messages).toEqual([
      {
        role: 'user',
        content: { type: 'text', text: 'Say hello to Ada.' },
      },
    ])
  })
})

describe('MCPManager sign-in', () => {
  it('asks for a sign-in, then connects once the user has signed in', async () => {
    server = await startFakeMcpServer()
    server.requireToken('token-1')
    const config = { url: server.httpUrl, transport: 'http' as const }
    const mcp = newManager()
    await mcp.addServer('fake', config)

    expect(statusOf('fake')).toMatchObject({ status: 'needs-auth', tools: [] })
    // Connecting alone registers nothing on the user's behalf.
    expect(server.oauth.registrations).toBe(0)

    const started = await startMcpOAuthFlow({
      serverName: 'fake',
      config,
      redirectUrl: REDIRECT,
      agentHome: home,
    })
    expect(started.authorized).toBe(false)
    const authorization = new URL(started.authorizationUrl!)
    expect(authorization.origin + authorization.pathname).toBe(
      `${server.origin}/authorize`,
    )
    expect(authorization.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(authorization.searchParams.get('client_id')).toBe('client-1')
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy()
    const state = authorization.searchParams.get('state')!

    const finished = await finishMcpOAuthFlow(state, 'the-code')
    expect(finished).toEqual({
      serverName: 'fake',
      file: mcpCredentialsPath(home, 'fake', config.url),
    })
    const exchange = server.oauth.tokenRequests.at(-1)!
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('the-code')
    expect(exchange.get('code_verifier')).toBeTruthy()
    expect(fs.statSync(finished.file).mode & 0o777).toBe(0o600)

    await mcp.reconnectWithCredentials(finished.file)
    expect(statusOf('fake')).toMatchObject({
      status: 'connected',
      tools: ['echo'],
    })
    expect(await call(mcp.getAllTools().fake_echo, { text: 'in' })).toContain(
      'echo: in',
    )
  })

  it('accepts each sign-in link once', async () => {
    server = await startFakeMcpServer()
    server.requireToken('token-1')
    const started = await startMcpOAuthFlow({
      serverName: 'fake',
      config: { url: server.httpUrl, transport: 'http' },
      redirectUrl: REDIRECT,
      agentHome: home,
    })
    const state = new URL(started.authorizationUrl!).searchParams.get('state')!

    await finishMcpOAuthFlow(state, 'the-code')
    await expect(finishMcpOAuthFlow(state, 'the-code')).rejects.toThrow(
      /expired/,
    )
    await expect(finishMcpOAuthFlow('made-up', 'the-code')).rejects.toThrow(
      /expired/,
    )
  })

  it('refreshes a rejected token without asking', async () => {
    server = await startFakeMcpServer()
    server.requireToken('token-1')
    const config = { url: server.httpUrl, transport: 'http' as const }
    const started = await startMcpOAuthFlow({
      serverName: 'fake',
      config,
      redirectUrl: REDIRECT,
      agentHome: home,
    })
    await finishMcpOAuthFlow(
      new URL(started.authorizationUrl!).searchParams.get('state')!,
      'the-code',
    )

    // The server stops accepting the token we hold.
    server.requireToken('token-2')
    server.oauth.nextAccessToken = 'token-2'
    await newManager().addServer('fake', config)

    expect(statusOf('fake')?.status).toBe('connected')
    expect(server.oauth.tokenRequests.at(-1)!.get('grant_type')).toBe(
      'refresh_token',
    )
  })

  it('asks again when the refresh is refused', async () => {
    server = await startFakeMcpServer()
    server.requireToken('token-1')
    const config = { url: server.httpUrl, transport: 'http' as const }
    const started = await startMcpOAuthFlow({
      serverName: 'fake',
      config,
      redirectUrl: REDIRECT,
      agentHome: home,
    })
    const { file } = await finishMcpOAuthFlow(
      new URL(started.authorizationUrl!).searchParams.get('state')!,
      'the-code',
    )

    server.requireToken('token-2')
    server.oauth.refuseRefresh = true
    await newManager().addServer('fake', config)

    expect(statusOf('fake')?.status).toBe('needs-auth')
    expect(hasMcpTokens(file)).toBe(false)
  })

  it('uses a client registered by hand instead of registering', async () => {
    server = await startFakeMcpServer()
    server.requireToken('token-1')
    const started = await startMcpOAuthFlow({
      serverName: 'fake',
      config: {
        url: server.httpUrl,
        transport: 'http',
        oauth: { clientId: 'by-hand' },
      },
      redirectUrl: REDIRECT,
      agentHome: home,
    })

    expect(
      new URL(started.authorizationUrl!).searchParams.get('client_id'),
    ).toBe('by-hand')
    expect(server.oauth.registrations).toBe(0)
  })

  it('does not offer a sign-in when the configured token is refused', async () => {
    server = await startFakeMcpServer()
    server.requireToken('token-1')
    await newManager().addServer('fake', {
      url: server.httpUrl,
      transport: 'http',
      headers: { Authorization: 'Bearer wrong' },
    })

    expect(statusOf('fake')?.status).toBe('error')
  })
})
