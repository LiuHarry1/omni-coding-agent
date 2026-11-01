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
})
