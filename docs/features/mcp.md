# MCP servers

Last verified: 2026-11-15

## Overview

A Model Context Protocol server gives the agent tools, and optionally resources and prompts. Servers run as a local command (stdio) or are reached over HTTP (streamable HTTP or SSE). This page covers what the client does once a server is configured: keeping the connection alive, following changes the server announces, exposing resources and prompts, and signing in with OAuth.

## How it works

**Connections.** Each server is connected when a workspace first needs it and reused across turns (see [Extensions](../architecture/extensions.md) for pooling). A server's status is one of `connected`, `reconnecting`, `needs-auth`, `error`, or `disconnected`.

**Reconnecting.** When an established connection drops — a stdio process exits, an HTTP stream gives up, or three network errors arrive in a row — the client reconnects: up to 5 attempts, the first at once, then after 1 s, 2 s, 4 s, and 8 s (the wait is capped at 30 s). Tools are bound to the server rather than to one connection, so a turn that is already running keeps its tools: a call made during a reconnect waits for it. After the last attempt fails the server is `error` and its tools are withheld from later turns. A server that never connected is not retried on its own; use Reconnect.

**Expired sessions.** When a streamable-HTTP server answers 404 with JSON-RPC code `-32001`, it no longer knows the session. The request never reached a tool, so the client reconnects and repeats that one call once. Calls that fail for any other reason are not repeated.

**Tool list changes.** On `notifications/tools/list_changed` the client fetches the server's tools again. Turns that start afterwards see the new list; a turn in progress keeps the list it started with. `notifications/prompts/list_changed` drops the cached prompt list.

**Resources.** While at least one connected server offers resources, two tools are available: `ListMcpResources` (optional `server`) and `ReadMcpResource` (`server`, `uri`). Both are read-only, so they also work in Ask mode, where MCP tools themselves are refused. Like MCP tools they are deferred: the model finds them with `ToolSearch` before the first call. Text content is returned as is. Binary content is written to a file under the session's `tool-results/` directory and the tool returns its path.

**Prompts.** Each prompt a connected server offers is a slash command named `/mcp__<server>__<prompt>`; characters other than letters, digits, `_`, and `-` in either name become `_`. What follows the command is split into the prompt's arguments in declared order: quotes group words, and the last argument takes the rest of the line. The prompt's messages become the text of the user message; images and binary resources in a prompt are replaced by a placeholder.

**Signing in.** A remote server that answers 401, and has no `Authorization` header configured, is `needs-auth`. Sign in from **Extensions → MCP**: the app opens the provider's page in a new tab, the provider sends the browser back to `/mcp/oauth/callback`, and the server connects. The client registers itself with the provider on first sign-in (dynamic client registration) unless the server's configuration names a client. Access tokens are refreshed when the server rejects them; if the refresh is refused the server goes back to `needs-auth`.

## Configuration and API

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": { "url": "https://mcp.example.com/mcp", "transport": "http" },
    "issues": {
      "url": "https://issues.example.com/mcp",
      "transport": "http",
      "oauth": {
        "clientId": "my-registered-client",
        "clientSecret": "optional"
      }
    }
  }
}
```

- `transport` is `http` (streamable HTTP) or `sse`; a server with a `url` and no `transport` uses SSE.
- `headers` are sent with every request. A configured `Authorization` header means the server is never offered a sign-in.
- `oauth.clientId` (and `oauth.clientSecret` when the provider issued one) is for providers that do not support dynamic client registration. Register `<public URL>/mcp/oauth/callback` as the redirect URI.

| Route                                              | Purpose                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /mcp`                                         | Status of every configured server: `status`, `tools`, `error`, and whether it offers `resources` and `prompts`.            |
| `POST /mcp/reconnect` `{ name }`                   | Drop the connection and connect again. Answers like `GET /mcp`.                                                            |
| `POST /mcp/oauth/start` `{ name, redirect_base? }` | Begin a sign-in. Answers `{ authorization_url }`, or `{ authorized: true, … }` when the stored sign-in could be refreshed. |
| `GET /mcp/oauth/callback?code&state`               | Where the provider returns the browser. Not behind the app's own auth; see below.                                          |
| `GET /slash-commands`                              | Includes MCP prompts as entries of kind `mcp-prompt`.                                                                      |

The redirect URI is `AGENT_PUBLIC_URL` when set, otherwise the address the web app reaches the API on, otherwise the request's own host.

Credentials are stored per user in `~/.ai-agent/mcp-oauth/<hash>.json` (mode `0600`), keyed by server name and URL. Removing a server through the settings API deletes its file; changing its URL starts over.

## Failure modes and security notes

- The callback is reachable without the app's token, because the browser arrives from the provider without it. It acts only on a `state` value this server issued for a sign-in in progress; each value works once and expires after 10 minutes. Sign-ins in progress are held in memory, so one that spans a server restart has to be started again.
- Sign-in needs a browser that can reach this server's HTTP endpoint. The CLI and ACP entry points cannot start one; sign in from the web or desktop app and they use the stored tokens.
- Tokens and `oauth.clientSecret` are stored unencrypted, protected by file permissions only.
- The slash menu waits at most 1.5 s for servers that are still connecting; their prompts are missing from the menu until it is loaded again, but still run when typed.
- Resource tools are registered per turn. If the only server with resources disconnects, they are absent from the next turn.
- Subscriptions to individual resources, server-initiated sampling, and elicitation are not implemented; a server that requests them gets "method not found".

## Source map

- `src/services/mcp/manager.ts` — connections, reconnect, tool binding, resources, prompts.
- `src/services/mcp/transport.ts` — transports and the tap that reads notifications and dropped connections off the wire.
- `src/services/mcp/oauth.ts` — credential store, OAuth provider, sign-in flow.
- `src/services/mcp/prompts.ts` — prompts as slash commands.
- `src/services/mcp/lifecycle.ts` — manager pooling.
- `src/tools/McpResourceTools/McpResourceTools.ts` — `ListMcpResources`, `ReadMcpResource`.
- `src/server/routes/mcp.ts` — reconnect and sign-in routes.
- `web/src/components/extensions/McpSection.jsx` — status, Reconnect, Sign in.
