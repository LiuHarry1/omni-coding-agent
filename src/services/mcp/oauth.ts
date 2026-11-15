/**
 * OAuth sign-in for remote MCP servers.
 *
 * Credentials live in one file per server under the user's app directory.
 * Connecting only ever uses what is stored (and refreshes it); the sign-in
 * itself is a separate, user-started flow: `startMcpOAuthFlow` returns the
 * authorization URL, the provider redirects the browser to our callback, and
 * `finishMcpOAuthFlow` exchanges the code.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { APP_NAME } from '../../brand.js'
import type { MCPServerHTTP } from '../../core/types.js'
import { getAppDirName } from '../../utils/app-dir.js'

interface StoredCredentials {
  serverUrl?: string
  /** The redirect URL the client was registered with and tokens were issued for. */
  redirectUrl?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
}

/** Where a server's credentials are kept. Changing its URL starts over. */
export function mcpCredentialsPath(
  agentHome: string,
  serverName: string,
  serverUrl: string,
): string {
  const key = crypto
    .createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(serverUrl)
    .digest('hex')
    .slice(0, 32)
  return path.join(agentHome, getAppDirName(), 'mcp-oauth', `${key}.json`)
}

function readCredentials(file: string): StoredCredentials {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object'
      ? (parsed as StoredCredentials)
      : {}
  } catch {
    return {}
  }
}

function writeCredentials(file: string, value: StoredCredentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function updateCredentials(
  file: string,
  change: (current: StoredCredentials) => StoredCredentials,
): void {
  writeCredentials(file, change(readCredentials(file)))
}

export function hasMcpTokens(file: string): boolean {
  return Boolean(readCredentials(file).tokens?.access_token)
}

export function clearMcpCredentials(file: string): void {
  fs.rmSync(file, { force: true })
}

interface ProviderOptions {
  file: string
  serverUrl: string
  redirectUrl: string
  state?: string
  /** A client registered by hand, for servers without dynamic registration. */
  staticClient?: MCPServerHTTP['oauth']
}

class McpOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK decides the user has to sign in. */
  authorizationUrl: URL | undefined
  #options: ProviderOptions
  #codeVerifier = ''

  constructor(options: ProviderOptions) {
    this.#options = options
  }

  get redirectUrl(): string {
    return this.#options.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_NAME,
      redirect_uris: [this.#options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.#options.state ?? ''
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const fixed = this.#options.staticClient
    if (fixed?.clientId) {
      return {
        client_id: fixed.clientId,
        ...(fixed.clientSecret ? { client_secret: fixed.clientSecret } : {}),
      }
    }
    const stored = readCredentials(this.#options.file)
    // A registration is only good for the redirect URL it was made with.
    if (stored.redirectUrl !== this.#options.redirectUrl) return undefined
    return stored.clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    updateCredentials(this.#options.file, current => ({
      ...current,
      serverUrl: this.#options.serverUrl,
      redirectUrl: this.#options.redirectUrl,
      clientInformation,
    }))
  }

  tokens(): OAuthTokens | undefined {
    return readCredentials(this.#options.file).tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    updateCredentials(this.#options.file, current => ({
      ...current,
      serverUrl: this.#options.serverUrl,
      redirectUrl: this.#options.redirectUrl,
      // A refresh response may leave the refresh token out; keep the old one.
      tokens: {
        ...tokens,
        refresh_token: tokens.refresh_token ?? current.tokens?.refresh_token,
      },
    }))
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.#codeVerifier) throw new Error('No sign-in is in progress')
    return this.#codeVerifier
  }

  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): void {
    if (scope === 'verifier') {
      this.#codeVerifier = ''
      return
    }
    updateCredentials(this.#options.file, current => {
      const next = { ...current }
      if (scope === 'all' || scope === 'tokens') delete next.tokens
      if (scope === 'all' || scope === 'client') delete next.clientInformation
      if (scope === 'all' || scope === 'discovery') delete next.discoveryState
      return next
    })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readCredentials(this.#options.file).discoveryState
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    updateCredentials(this.#options.file, current => ({
      ...current,
      discoveryState,
    }))
  }
}

/**
 * The provider a connection uses: stored tokens, refreshed when the server
 * rejects them. Undefined when nobody has signed in, so a server that needs
 * it answers 401 and nothing is registered on the user's behalf.
 */
export function storedMcpAuthProvider(
  file: string,
  config: MCPServerHTTP,
): OAuthClientProvider | undefined {
  const stored = readCredentials(file)
  if (!stored.tokens?.access_token || !stored.redirectUrl) return undefined
  return new McpOAuthProvider({
    file,
    serverUrl: config.url,
    redirectUrl: stored.redirectUrl,
    staticClient: config.oauth,
  })
}

interface PendingFlow {
  provider: McpOAuthProvider
  serverName: string
  serverUrl: string
  file: string
  resourceMetadataUrl?: URL
  expiresAt: number
}

export interface FinishedMcpOAuthFlow {
  serverName: string
  /** The credentials file that now holds tokens. */
  file: string
}

const FLOW_TTL_MS = 10 * 60 * 1000
const pendingFlows = new Map<string, PendingFlow>()

function sweepExpiredFlows(): void {
  const now = Date.now()
  for (const [state, flow] of pendingFlows) {
    if (flow.expiresAt <= now) pendingFlows.delete(state)
  }
}

/**
 * Ask the server what it wants: a 401 names the metadata document and scope
 * to use. Servers that do not say fall back to well-known discovery.
 */
async function readAuthChallenge(
  config: MCPServerHTTP,
): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  const streamable = config.transport === 'http'
  try {
    const response = await fetch(config.url, {
      method: streamable ? 'POST' : 'GET',
      headers: {
        ...(config.headers ?? {}),
        accept: streamable
          ? 'application/json, text/event-stream'
          : 'text/event-stream',
        ...(streamable ? { 'content-type': 'application/json' } : {}),
      },
      body: streamable
        ? JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })
        : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel().catch(() => {})
    if (response.status !== 401) return {}
    const { resourceMetadataUrl, scope } =
      extractWWWAuthenticateParams(response)
    return { resourceMetadataUrl, scope }
  } catch {
    return {}
  }
}

export interface StartMcpOAuthFlowInput {
  serverName: string
  config: MCPServerHTTP
  /** Our callback, as the user's browser reaches it. */
  redirectUrl: string
  agentHome: string
}

/**
 * Begin a sign-in. Returns the URL to send the user to, or
 * `authorized: true` when stored credentials could simply be refreshed.
 */
export async function startMcpOAuthFlow(
  input: StartMcpOAuthFlowInput,
): Promise<{ authorized: boolean; authorizationUrl?: string; file: string }> {
  sweepExpiredFlows()
  const { serverName, config, redirectUrl } = input
  const file = mcpCredentialsPath(input.agentHome, serverName, config.url)
  const state = crypto.randomBytes(24).toString('base64url')
  const provider = new McpOAuthProvider({
    file,
    serverUrl: config.url,
    redirectUrl,
    state,
    staticClient: config.oauth,
  })
  const challenge = await readAuthChallenge(config)
  const result = await auth(provider, {
    serverUrl: config.url,
    resourceMetadataUrl: challenge.resourceMetadataUrl,
    scope: challenge.scope,
  })
  if (result === 'AUTHORIZED') return { authorized: true, file }
  if (!provider.authorizationUrl) {
    throw new Error(`${serverName} did not provide a sign-in URL`)
  }
  pendingFlows.set(state, {
    provider,
    serverName,
    serverUrl: config.url,
    file,
    resourceMetadataUrl: challenge.resourceMetadataUrl,
    expiresAt: Date.now() + FLOW_TTL_MS,
  })
  return {
    authorized: false,
    authorizationUrl: provider.authorizationUrl.href,
    file,
  }
}

/** Exchange the code the provider sent back. `state` names the sign-in. */
export async function finishMcpOAuthFlow(
  state: string,
  code: string,
): Promise<FinishedMcpOAuthFlow> {
  sweepExpiredFlows()
  const flow = pendingFlows.get(state)
  if (!flow) {
    throw new Error('This sign-in link has expired. Start again from the app.')
  }
  pendingFlows.delete(state)
  await auth(flow.provider, {
    serverUrl: flow.serverUrl,
    authorizationCode: code,
    resourceMetadataUrl: flow.resourceMetadataUrl,
  })
  return { serverName: flow.serverName, file: flow.file }
}

/** Drop a sign-in the provider refused, so its state cannot be replayed. */
export function abandonMcpOAuthFlow(state: string): string | undefined {
  const flow = pendingFlows.get(state)
  pendingFlows.delete(state)
  return flow?.serverName
}
