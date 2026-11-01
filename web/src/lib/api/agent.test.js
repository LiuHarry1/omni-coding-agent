import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentApi } from './agent.js'

function jsonResponse(body = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Marketplace API target contract', () => {
  it('sends explicit User and Workspace targets on every request shape', async () => {
    const fetchMock = vi.fn(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const user = { scope: 'user' }
    const workspace = {
      scope: 'workspace',
      environmentId: 'local',
      cwd: '/Users/alice/My Project',
    }
    const item = { kind: 'bundle', externalId: 'starter' }

    await agentApi.getMarketplaceProviders(user)
    await agentApi.marketplaceLogin(
      'private market',
      { username: 'alice', password: 'secret' },
      workspace,
    )
    await agentApi.marketplaceLogout('private market', workspace)
    await agentApi.getMarketplaceCatalog('private market', {
      kind: 'bundle',
      q: 'review tools',
      page: 2,
      perPage: 12,
      target: workspace,
    })
    await agentApi.getMarketplaceEnvSchema('private market', 'skill/one', user)
    await agentApi.installMarketplaceItem('private market', item, workspace, {
      confirmConflicts: true,
    })
    await agentApi.previewMarketplaceBundle('private market', item, user)
    await agentApi.uninstallMarketplaceItem('private market', item, workspace)

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/marketplaces/providers?scope=user',
      '/marketplaces/private%20market/auth/login?scope=workspace&environmentId=local&cwd=%2FUsers%2Falice%2FMy+Project',
      '/marketplaces/private%20market/auth/logout?scope=workspace&environmentId=local&cwd=%2FUsers%2Falice%2FMy+Project',
      '/marketplaces/private%20market/catalog?kind=bundle&q=review+tools&page=2&perPage=12&scope=workspace&environmentId=local&cwd=%2FUsers%2Falice%2FMy+Project',
      '/marketplaces/private%20market/env-schema?kind=skill&id=skill%2Fone&scope=user',
      '/marketplaces/private%20market/install?kind=bundle&id=starter&scope=workspace&environmentId=local&cwd=%2FUsers%2Falice%2FMy+Project',
      '/marketplaces/private%20market/preview?kind=bundle&id=starter&scope=user',
      '/marketplaces/private%20market/uninstall?kind=bundle&id=starter&scope=workspace&environmentId=local&cwd=%2FUsers%2Falice%2FMy+Project',
    ])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      username: 'alice',
      password: 'secret',
    })
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toEqual({
      confirmConflicts: true,
    })
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toEqual({})
    expect(fetchMock.mock.calls[7][1]).toMatchObject({ method: 'DELETE' })
  })

  it('retains the legacy workspace query and validates scoped handles', async () => {
    const fetchMock = vi.fn(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)

    await agentApi.getMarketplaceProviders('/legacy/project')
    expect(fetchMock).toHaveBeenCalledWith(
      '/marketplaces/providers?workspace=%2Flegacy%2Fproject',
      {},
    )
    expect(() =>
      agentApi.getMarketplaceProviders({
        scope: 'workspace',
        environmentId: 'local',
      }),
    ).toThrow(/environmentId and cwd/)
  })
})

describe('MCP API scope contract', () => {
  it('sends the exact writable scope when removing a server', async () => {
    const fetchMock = vi.fn(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)

    await agentApi.removeMcp('project-docs', 'project')

    expect(fetchMock).toHaveBeenCalledWith(
      '/settings/mcp',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          action: 'remove',
          scope: 'project',
          name: 'project-docs',
        }),
      }),
    )
  })
})

describe('Workspace-scoped status contracts', () => {
  it('sends the full workspace handle for agents and LSP', async () => {
    const fetchMock = vi.fn(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)

    const workspace = {
      environmentId: 'cloud:abcdef0123456789',
      cwd: '/workspace/repo',
    }
    await agentApi.getAgents(workspace)
    await agentApi.getLsp(workspace)

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/agents?environmentId=cloud%3Aabcdef0123456789&cwd=%2Fworkspace%2Frepo',
      '/lsp?environmentId=cloud%3Aabcdef0123456789&cwd=%2Fworkspace%2Frepo',
    ])
  })
})
