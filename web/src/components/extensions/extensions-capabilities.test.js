import { describe, expect, it } from 'vitest'
import { SAFE_DESKTOP_CAPABILITIES } from '../../stores/capabilities-model.js'
import { DEFAULT_EXTENSION_SECTIONS } from './ExtensionsHub.jsx'
import {
  createScopedExtensionConfigClient,
  enabledExtensionSections,
  enabledMcpTransports,
  extensionRuntimeLabel,
  extensionScopeOptions,
  resolveMarketplaceTarget,
  SSH_MARKETPLACE_TARGET_DISABLED_REASON,
} from './extensions-capabilities.js'

function manifest(profile = 'desktop') {
  const value = structuredClone(SAFE_DESKTOP_CAPABILITIES)
  value.profile = profile
  if (profile === 'cloud') {
    value.extensions.scopes = ['user']
    value.extensions.sections.plugins = {
      enabled: false,
      reason: 'Plugins are unavailable in the cloud runtime profile.',
    }
    value.mcp.transports = ['http', 'sse']
    value.marketplace.targets = ['user']
  }
  return value
}

describe('Extensions Hub capabilities', () => {
  it('keeps one shared section order and filters manifest-disabled sections', () => {
    const desktop = manifest()
    desktop.extensions.sections.rules = {
      enabled: false,
      reason: 'Rules are disabled by policy.',
    }

    expect(DEFAULT_EXTENSION_SECTIONS.map(section => section.id)).toEqual([
      'skills',
      'agents',
      'rules',
      'commands',
      'mcp',
      'lsp',
      'marketplace',
      'plugins',
    ])
    expect(
      enabledExtensionSections(DEFAULT_EXTENSION_SECTIONS, desktop).map(
        section => section.id,
      ),
    ).not.toContain('rules')
    expect(
      enabledExtensionSections(
        DEFAULT_EXTENSION_SECTIONS,
        manifest('cloud'),
      ).map(section => section.id),
    ).not.toContain('plugins')
  })

  it('labels the runtime from the capability profile', () => {
    expect(extensionRuntimeLabel('desktop')).toBe('Desktop')
    expect(extensionRuntimeLabel('cloud')).toBe('Cloud')
  })

  it('exposes only supported scopes and targets the current workspace handle', () => {
    const desktop = manifest()
    const handle = { environmentId: 'ssh:build', cwd: '/srv/project' }

    expect(extensionScopeOptions(desktop, null)).toEqual([
      { id: 'user', label: 'User', enabled: true, reason: null },
      {
        id: 'workspace',
        label: 'Workspace',
        enabled: false,
        reason: 'Select a workspace before using Workspace scope.',
      },
    ])

    const workspace = createScopedExtensionConfigClient(
      desktop,
      'workspace',
      handle,
    )
    expect(workspace).toMatchObject({
      enabled: true,
      reason: null,
      target: { scope: 'workspace', workspace: handle },
    })
    expect(workspace.client.target).toEqual({
      scope: 'workspace',
      workspace: handle,
    })

    const cloud = manifest('cloud')
    expect(extensionScopeOptions(cloud, handle).map(scope => scope.id)).toEqual(
      ['user'],
    )
    expect(
      createScopedExtensionConfigClient(cloud, 'workspace', handle),
    ).toMatchObject({
      enabled: false,
      client: null,
      reason: expect.stringMatching(/unavailable.*Cloud/i),
    })
  })

  it('filters MCP transports through the effective manifest', () => {
    expect(enabledMcpTransports(manifest())).toEqual(['stdio', 'http', 'sse'])
    expect(enabledMcpTransports(manifest('cloud'))).toEqual(['http', 'sse'])

    const disabled = manifest()
    disabled.mcp.enabled = false
    disabled.mcp.transports = ['stdio', 'invalid', 'http', 'http']
    expect(enabledMcpTransports(disabled)).toEqual([])
  })

  it('models Marketplace targets and explains unsupported SSH mutation', () => {
    const desktop = manifest()
    const local = { environmentId: 'local', cwd: '/srv/project' }
    const ssh = { environmentId: 'ssh:build', cwd: '/srv/project' }

    expect(resolveMarketplaceTarget(desktop.marketplace, 'user', ssh)).toEqual({
      enabled: true,
      reason: null,
      target: { scope: 'user' },
    })
    expect(
      resolveMarketplaceTarget(desktop.marketplace, 'workspace', local),
    ).toEqual({
      enabled: true,
      reason: null,
      target: {
        scope: 'workspace',
        environmentId: 'local',
        cwd: '/srv/project',
      },
    })
    expect(
      resolveMarketplaceTarget(desktop.marketplace, 'workspace', ssh),
    ).toEqual({
      enabled: false,
      reason: SSH_MARKETPLACE_TARGET_DISABLED_REASON,
      target: null,
    })
    expect(SSH_MARKETPLACE_TARGET_DISABLED_REASON).toMatch(
      /SSH.*atomic install.*rollback.*ownership/i,
    )

    const cloud = manifest('cloud')
    expect(
      resolveMarketplaceTarget(cloud.marketplace, 'user', local),
    ).toMatchObject({ enabled: true, target: { scope: 'user' } })
    expect(
      resolveMarketplaceTarget(cloud.marketplace, 'workspace', local),
    ).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/Workspace.*unavailable.*runtime profile/i),
    })
  })
})
