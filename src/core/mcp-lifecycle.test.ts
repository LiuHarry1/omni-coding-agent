import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMCPManagerForServers } from './mcp-lifecycle.js'
import { MCPManager } from './mcp-manager.js'

const previousCloud = process.env.CLOUD_WORKSPACES

afterEach(() => {
  if (previousCloud === undefined) delete process.env.CLOUD_WORKSPACES
  else process.env.CLOUD_WORKSPACES = previousCloud
  vi.restoreAllMocks()
})

describe('MCP transport policy', () => {
  it('never hands stdio servers to the manager in cloud mode', async () => {
    process.env.CLOUD_WORKSPACES = 'docker'
    const add = vi
      .spyOn(MCPManager.prototype, 'addServer')
      .mockResolvedValue(undefined)

    await getMCPManagerForServers('/tmp/cloud-mcp-policy', {
      docs: { url: 'https://mcp.example.com', transport: 'http' },
      local: { command: 'node', args: ['server.js'] },
    })

    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith('docs', {
      url: 'https://mcp.example.com',
      transport: 'http',
    })
  })

  it('keeps desktop stdio behavior when cloud mode is off', async () => {
    delete process.env.CLOUD_WORKSPACES
    const add = vi
      .spyOn(MCPManager.prototype, 'addServer')
      .mockResolvedValue(undefined)

    await getMCPManagerForServers('/tmp/desktop-mcp-policy', {
      local: { command: 'node', args: ['server.js'] },
    })

    expect(add).toHaveBeenCalledWith('local', {
      command: 'node',
      args: ['server.js'],
    })
  })

  it('connects servers concurrently and shares an opening manager', async () => {
    delete process.env.CLOUD_WORKSPACES
    const releases: Array<() => void> = []
    const add = vi.spyOn(MCPManager.prototype, 'addServer').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          releases.push(resolve)
        }),
    )
    const servers = {
      first: { url: 'https://first.example.com', transport: 'http' as const },
      second: {
        url: 'https://second.example.com',
        transport: 'http' as const,
      },
    }

    const first = getMCPManagerForServers('/tmp/concurrent-mcp', servers)
    const second = getMCPManagerForServers('/tmp/concurrent-mcp', servers)
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2))
    releases.forEach(release => release())

    expect(await first).toBe(await second)
    expect(add).toHaveBeenCalledTimes(2)
  })
})
