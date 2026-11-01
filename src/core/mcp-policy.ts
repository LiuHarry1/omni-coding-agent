import type { MCPServerConfig, MCPServerHTTP } from './types.js'

const MASKED_VALUE = '••••••••'
const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
  'metadata.google.internal',
])

export interface SafeMCPServerMetadata {
  transport: 'stdio' | 'http' | 'sse'
  url?: string
  headerNames?: string[]
  configuredBy?: 'plugin' | 'user' | 'project' | 'local' | 'managed'
  writable?: boolean
  writableScope?: 'user' | 'project' | 'local'
}

type MCPProvenance = Pick<
  SafeMCPServerMetadata,
  'configuredBy' | 'writable' | 'writableScope'
>

export function isCloudMetadataUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    return CLOUD_METADATA_HOSTS.has(hostname)
  } catch {
    return false
  }
}

function isHttpServer(value: MCPServerConfig): value is MCPServerHTTP {
  if (
    !value ||
    typeof value !== 'object' ||
    'command' in value ||
    typeof value.url !== 'string'
  ) {
    return false
  }
  if (
    value.transport !== undefined &&
    value.transport !== 'http' &&
    value.transport !== 'sse'
  ) {
    return false
  }
  try {
    const protocol = new URL(value.url).protocol
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      !isCloudMetadataUrl(value.url)
    )
  } catch {
    return false
  }
}

/** Keep only network MCP transports that cannot spawn a local process. */
export function filterHttpMCPServers(
  servers: Record<string, MCPServerConfig>,
): {
  servers: Record<string, MCPServerHTTP>
  dropped: string[]
} {
  const allowed: Record<string, MCPServerHTTP> = {}
  const dropped: string[] = []
  for (const [name, config] of Object.entries(servers)) {
    if (isHttpServer(config)) allowed[name] = config
    else dropped.push(name)
  }
  return { servers: allowed, dropped }
}

function maskMCPUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = MASKED_VALUE
    if (url.password) url.password = MASKED_VALUE
    for (const name of new Set(url.searchParams.keys())) {
      url.searchParams.set(name, MASKED_VALUE)
    }
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * Return enough MCP configuration for status UIs without exposing commands,
 * environment values, request-header values, or URL credentials.
 */
export function getSafeMCPServerMetadata(
  servers: Record<string, MCPServerConfig>,
  provenance: Record<string, MCPProvenance> = {},
): Record<string, SafeMCPServerMetadata> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => {
      const ownership = provenance[name] ?? {}
      if ('command' in config) {
        return [name, { transport: 'stdio', ...ownership }]
      }
      const headerNames = Object.keys(config.headers ?? {})
      return [
        name,
        {
          transport: config.transport ?? 'sse',
          url: maskMCPUrl(config.url),
          ...(headerNames.length > 0 ? { headerNames } : {}),
          ...ownership,
        },
      ]
    }),
  )
}
