import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspace } from '../../core/workspace.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  filterCloudMCPServers,
  resolveTurnWorkspaceScope,
} from './turn-scope.js'

describe('cloud turn scope', () => {
  it('separates request-scoped configuration from container tools', () => {
    const home = path.resolve('/srv/users/alice')
    runWithRequestScope({ agentHome: home, cwd: home }, () => {
      expect(
        resolveTurnWorkspaceScope(
          {
            environmentId: 'cloud:abcdef0123456789',
            cwd: '/workspace/repo',
          },
          '/workspace/repo',
        ),
      ).toEqual({
        toolCwd: '/workspace/repo',
        extensionCwd: home,
        settingsCwd: home,
        extensionRoot: path.join(home, '.ai-agent'),
        cloudWorkspaceId: 'abcdef0123456789',
        remote: true,
      })
    })
  })

  it('fails closed without a request scope', () => {
    const previousAuth = process.env.AUTH_ENABLED
    process.env.AUTH_ENABLED = 'true'
    try {
      expect(() =>
        resolveTurnWorkspaceScope(
          {
            environmentId: 'cloud:abcdef0123456789',
            cwd: '/workspace/repo',
          },
          '/workspace/repo',
        ),
      ).toThrow(/request-scoped agent home/)
    } finally {
      if (previousAuth === undefined) delete process.env.AUTH_ENABLED
      else process.env.AUTH_ENABLED = previousAuth
    }
  })

  it('keeps local and SSH control-plane roots unchanged', () => {
    expect(
      resolveTurnWorkspaceScope(
        { environmentId: 'local', cwd: '/project' },
        '/project',
      ),
    ).toMatchObject({
      toolCwd: '/project',
      extensionCwd: '/project',
      settingsCwd: '/project',
      remote: false,
    })
    expect(
      resolveTurnWorkspaceScope(
        { environmentId: 'ssh:dev', cwd: '/srv/project' },
        '/srv/project',
      ),
    ).toMatchObject({
      toolCwd: '/srv/project',
      extensionCwd: getDefaultWorkspace(),
      settingsCwd: getDefaultWorkspace(),
      remote: true,
    })
  })
})

describe('cloud MCP policy', () => {
  it('keeps HTTP/SSE and drops stdio or non-HTTP transports', () => {
    const result = filterCloudMCPServers({
      docs: { url: 'https://mcp.example.com/mcp', transport: 'http' },
      events: { url: 'http://mcp.example.com/sse', transport: 'sse' },
      implicit: { url: 'https://mcp.example.com/default' },
      local: { command: 'node', args: ['server.js'] },
      file: { url: 'file:///tmp/mcp.sock' },
    })

    expect(result.servers).toEqual({
      docs: { url: 'https://mcp.example.com/mcp', transport: 'http' },
      events: { url: 'http://mcp.example.com/sse', transport: 'sse' },
      implicit: { url: 'https://mcp.example.com/default' },
    })
    expect(result.dropped).toEqual(['local', 'file'])
  })
})
