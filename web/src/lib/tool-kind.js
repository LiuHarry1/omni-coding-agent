/**
 * Classify tool names for UI routing. MCP tools are merged as
 * `{mcpServerName}_{toolName}` (see src/services/mcp/manager.ts).
 */

/** Longest-first MCP server names for prefix matching (set from live config). */
let knownMcpServers = []

/** Register MCP server names so `parseMcpToolName` can split accurately. */
export function setKnownMcpServers(names) {
  const list = Array.isArray(names)
    ? names.filter(n => typeof n === 'string' && n.length > 0)
    : []
  knownMcpServers = [...new Set(list)].sort((a, b) => b.length - a.length)
}

export function getKnownMcpServers() {
  return knownMcpServers.slice()
}

/** Built-in `WebFetch` and MCP names like `mcp_server_fetch`. */
export function isFetchTool(name) {
  if (!name) return false
  if (name === 'WebFetch' || name === 'fetch') return true
  return name.endsWith('_fetch')
}

/** Built-in `WebSearch` and MCP search tools (`*_search`, `*_web_search`). */
export function isSearchTool(name) {
  if (!name) return false
  if (name === 'WebSearch' || name === 'search') return true
  return name.endsWith('_search') || name.endsWith('_web_search')
}

/**
 * Split a merged MCP tool name into server + tool.
 * Prefer known server prefixes, then fetch/search suffixes, else last `_`.
 */
export function parseMcpToolName(name) {
  if (!name) return { server: null, tool: '' }

  for (const server of knownMcpServers) {
    const prefix = `${server}_`
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { server, tool: name.slice(prefix.length) }
    }
  }

  const suffixes = ['WebSearch', 'WebFetch', 'web_search', 'fetch', 'search']
  for (const suffix of suffixes) {
    const marker = `_${suffix}`
    if (name.endsWith(marker) && name.length > marker.length) {
      return {
        server: name.slice(0, -marker.length) || null,
        tool: suffix,
      }
    }
  }

  const idx = name.lastIndexOf('_')
  if (idx > 0 && idx < name.length - 1) {
    return {
      server: name.slice(0, idx),
      tool: name.slice(idx + 1),
    }
  }
  return { server: null, tool: name }
}

/** Display title: `server/tool` or bare tool name. */
export function formatMcpToolTitle(name) {
  const { server, tool } = parseMcpToolName(name)
  if (server && tool) return `${server}/${tool}`
  return tool || name || ''
}
