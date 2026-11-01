import { describe, expect, it } from 'vitest'
import { filterHttpMCPServers, getSafeMCPServerMetadata } from './mcp-policy.js'

describe('MCP status metadata', () => {
  it('keeps display metadata without exposing credentials or executable config', () => {
    const metadata = getSafeMCPServerMetadata({
      docs: {
        transport: 'http',
        url: 'https://client:password@mcp.example.com/mcp?token=url-secret',
        headers: {
          Authorization: 'Bearer header-secret',
          'X-Tenant': 'acme',
        },
      },
      events: {
        url: 'https://mcp.example.com/events',
      },
      local: {
        command: 'node',
        args: ['secret-server.js'],
        env: { API_KEY: 'process-secret' },
      },
    })

    expect(metadata.docs).toMatchObject({
      transport: 'http',
      headerNames: ['Authorization', 'X-Tenant'],
    })
    expect(metadata.docs.url).toContain('mcp.example.com/mcp')
    expect(metadata.events).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/events',
    })
    expect(metadata.local).toEqual({ transport: 'stdio' })

    const serialized = JSON.stringify(metadata)
    for (const secret of [
      'client',
      'password',
      'url-secret',
      'header-secret',
      'acme',
      'secret-server.js',
      'process-secret',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })
})

describe('cloud MCP policy', () => {
  it('keeps ordinary public and internal HTTP/SSE servers', () => {
    const result = filterHttpMCPServers({
      public: { transport: 'http', url: 'https://mcp.example.com' },
      internal: { transport: 'sse', url: 'http://10.20.30.40:8080/sse' },
      localhost: { transport: 'http', url: 'http://localhost:9000/mcp' },
    })

    expect(Object.keys(result.servers)).toEqual([
      'public',
      'internal',
      'localhost',
    ])
    expect(result.dropped).toEqual([])
  })

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://169.254.170.2/v2/credentials',
    'http://100.100.100.200/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://[fd00:ec2::254]/latest/meta-data',
  ])('rejects known cloud metadata target %s', url => {
    const result = filterHttpMCPServers({
      metadata: { transport: 'http', url },
    })
    expect(result.servers).toEqual({})
    expect(result.dropped).toEqual(['metadata'])
  })
})
