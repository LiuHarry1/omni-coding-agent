export const MASKED_SECRET = '••••••••'
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse']

export function normalizeMcpName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
}

export function headerNames(headers) {
  if (Array.isArray(headers)) return headers.map(String).filter(Boolean)
  if (!headers || typeof headers !== 'object') return []
  return Object.keys(headers)
}

export function maskMcpHeaders(headers) {
  return Object.fromEntries(
    headerNames(headers).map(name => [name, MASKED_SECRET]),
  )
}

export function maskMcpUrl(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.username) url.username = MASKED_SECRET
    if (url.password) url.password = MASKED_SECRET
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.set(key, MASKED_SECRET)
    }
    return url.toString()
  } catch {
    return String(value).split('?')[0]
  }
}

export function normalizeMcpResponse(response, remembered = {}) {
  const statuses = response?.servers || response?.mcpStatus || []
  const configs =
    response?.effectiveMcpServers ||
    response?.mcpServers ||
    response?.configs ||
    {}
  const names = new Set([
    ...statuses.map(server => server.name),
    ...Object.keys(configs),
    ...Object.keys(remembered),
  ])

  return [...names]
    .filter(Boolean)
    .map(name => {
      const status = statuses.find(server => server.name === name) || {}
      const config = configs[name] || status.config || remembered[name] || {}
      const headers = headerNames(
        config.headers ||
          config.headerNames ||
          status.headers ||
          status.headerNames,
      )
      const configuredBy =
        status.configuredBy ||
        config.configuredBy ||
        config.source ||
        remembered[name]?.configuredBy ||
        'user'
      const writable =
        config.writable ??
        status.writable ??
        ['user', 'project', 'local'].includes(configuredBy)
      return {
        name,
        status: status.status || 'disconnected',
        tools: status.tools || [],
        error: status.error,
        transport:
          config.transport ||
          status.transport ||
          (config.url || status.url ? 'sse' : 'unknown'),
        url: maskMcpUrl(
          config.url || status.url || remembered[name]?.url || '',
        ),
        headerNames: headers,
        configuredBy,
        writable,
        writableScope:
          config.writableScope ||
          status.writableScope ||
          (writable ? configuredBy : null),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function isRemoteMcpConfig(config) {
  return (
    (config?.transport === 'http' || config?.transport === 'sse') &&
    /^https?:\/\//i.test(config?.url || '')
  )
}

export function normalizeMcpTransports(transports) {
  return [
    ...new Set(
      (transports || []).filter(transport =>
        MCP_TRANSPORTS.includes(transport),
      ),
    ),
  ]
}

export function preferredMcpTransport(transports) {
  const available = normalizeMcpTransports(transports)
  return available.includes('http') ? 'http' : available[0] || ''
}

export function isAllowedMcpConfig(config, transports) {
  const available = normalizeMcpTransports(transports)
  if (!available.includes(config?.transport)) return false
  if (config.transport === 'stdio') return Boolean(config.command?.trim())
  return isRemoteMcpConfig(config)
}
