/**
 * Acting on MCP servers, beyond listing them (`GET /mcp` in the router).
 *
 *   POST /mcp/reconnect     { name }
 *        -- drop the server's connection and connect again
 *   POST /mcp/oauth/start   { name, redirect_base? }
 *        -- begin a sign-in; answers { authorization_url } to open in a
 *           browser, or { authorized: true } when stored credentials still work
 *   GET  /mcp/oauth/callback?code=…&state=…
 *        -- where the provider sends the browser back. Public: the browser
 *           arrives without our token, and `state` is the proof it belongs
 *           to a sign-in we started.
 *
 * The POSTs take `?workspace=` like `GET /mcp` and answer in its shape.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { APP_NAME } from '../../brand.js'
import type { MCPServerConfig } from '../../core/types.js'
import {
  getMCPManagerForServers,
  reconnectMCPServersWithCredentials,
} from '../../services/mcp/lifecycle.js'
import {
  abandonMcpOAuthFlow,
  finishMcpOAuthFlow,
  startMcpOAuthFlow,
} from '../../services/mcp/oauth.js'
import { getSafeMCPServerMetadata } from '../../services/mcp/policy.js'
import {
  listMcpPromptSlashEntries,
  type McpPromptSlashEntry,
} from '../../services/mcp/prompts.js'
import { isHttpServerConfig } from '../../services/mcp/transport.js'
import { resolveEffectiveSettings } from '../../utils/settings/manager.js'
import { resolveAgentHome } from '../../utils/workspace/request-scope.js'
import { readBody, sendJSON } from '../http.js'
import { resolveSettingsRequestCwd } from '../request-cwd.js'
import { getPreviewBaseUrl } from '../workspace/preview.js'

const CALLBACK_PATH = '/mcp/oauth/callback'
/** How long the slash menu waits for servers that are still connecting. */
const PROMPT_LIST_WAIT_MS = 1500

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ]!,
  )
}

function sendPage(
  res: ServerResponse,
  status: number,
  title: string,
  detail: string,
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(APP_NAME)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #f6f6f4; color: #1c1c1a; }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #55554f; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1a; color: #f0f0ec; }
    p { color: #b0b0a8; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>`)
}

/**
 * Our callback as the user's browser reaches it. The deployment's public URL
 * wins; otherwise the address the page itself talks to us on, then the
 * request's own host.
 */
function callbackUrl(req: IncomingMessage, hint: unknown): string {
  let base = getPreviewBaseUrl()
  if (!base && typeof hint === 'string' && /^https?:\/\//i.test(hint)) {
    base = hint
  }
  if (!base) {
    const forwarded = req.headers['x-forwarded-proto']
    const proto =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        ?.split(',')[0]
        ?.trim() || 'http'
    base = `${proto}://${req.headers.host ?? 'localhost'}`
  }
  return `${base.replace(/\/+$/, '')}${CALLBACK_PATH}`
}

/** Handles the provider's redirect. Call before the auth gate. */
export async function handleMcpOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const [pathname, search = ''] = (req.url ?? '').split('?')
  if (req.method !== 'GET' || pathname !== CALLBACK_PATH) return false

  const query = new URLSearchParams(search)
  const state = query.get('state') ?? ''
  const code = query.get('code')
  if (!code) {
    const server = state ? abandonMcpOAuthFlow(state) : undefined
    const reason =
      query.get('error_description') || query.get('error') || 'No code received'
    sendPage(
      res,
      400,
      'Sign-in did not complete',
      server ? `${server}: ${reason}` : reason,
    )
    return true
  }

  try {
    const finished = await finishMcpOAuthFlow(state, code)
    await reconnectMCPServersWithCredentials(finished.file)
    sendPage(
      res,
      200,
      `Signed in to ${finished.serverName}`,
      `You can close this tab and go back to ${APP_NAME}.`,
    )
  } catch (err) {
    sendPage(
      res,
      400,
      'Sign-in did not complete',
      err instanceof Error ? err.message : String(err),
    )
  }
  return true
}

async function sendStatus(
  res: ServerResponse,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const effective = await resolveEffectiveSettings(cwd)
  const manager = await getMCPManagerForServers(
    cwd,
    effective.effectiveMcpServers,
  )
  sendJSON(res, 200, {
    ...extra,
    servers: manager.getStatus(),
    configs: getSafeMCPServerMetadata(
      effective.effectiveMcpServers,
      effective.mcpProvenance,
    ),
  })
}

/** Handles the POSTs. Call behind the auth gate. */
export async function handleMcpActions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0]
  if (req.method !== 'POST') return false
  if (pathname !== '/mcp/reconnect' && pathname !== '/mcp/oauth/start') {
    return false
  }

  try {
    const body = await readBody(req)
    const name = typeof body.name === 'string' ? body.name : ''
    const cwd = resolveSettingsRequestCwd(req, req.url)
    const effective = await resolveEffectiveSettings(cwd)
    const config: MCPServerConfig | undefined =
      effective.effectiveMcpServers[name]
    if (!name || !config) {
      sendJSON(res, 404, { error: `No MCP server named '${name}'` })
      return true
    }

    if (pathname === '/mcp/reconnect') {
      const manager = await getMCPManagerForServers(
        cwd,
        effective.effectiveMcpServers,
      )
      await manager.reconnect(name)
      await sendStatus(res, cwd)
      return true
    }

    if (!isHttpServerConfig(config)) {
      sendJSON(res, 400, {
        error: 'Only HTTP and SSE MCP servers can be signed in to',
      })
      return true
    }
    const started = await startMcpOAuthFlow({
      serverName: name,
      config,
      redirectUrl: callbackUrl(req, body.redirect_base),
      agentHome: resolveAgentHome(),
    })
    if (started.authorized) {
      await reconnectMCPServersWithCredentials(started.file)
      await sendStatus(res, cwd, { authorized: true })
      return true
    }
    sendJSON(res, 200, {
      authorized: false,
      authorization_url: started.authorizationUrl,
    })
  } catch (err) {
    sendJSON(res, 400, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return true
}

/**
 * MCP prompts for the slash menu. Servers still connecting after a short
 * wait are left out rather than holding the menu up; their prompts still run
 * when typed.
 */
export async function listMcpPromptEntries(
  cwd: string,
): Promise<McpPromptSlashEntry[]> {
  const list = (async () => {
    const effective = await resolveEffectiveSettings(cwd)
    const servers = effective.effectiveMcpServers
    if (Object.keys(servers).length === 0) return []
    const manager = await getMCPManagerForServers(cwd, servers)
    return listMcpPromptSlashEntries(manager)
  })()
  list.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<McpPromptSlashEntry[]>(resolve => {
    timer = setTimeout(() => resolve([]), PROMPT_LIST_WAIT_MS)
  })
  try {
    return await Promise.race([list, timeout])
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
