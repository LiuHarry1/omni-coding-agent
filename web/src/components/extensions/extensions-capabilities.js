import { createExtensionConfigClient } from '../../lib/api/user-config.js'

const CONFIG_SECTION_IDS = new Set(['skills', 'agents', 'rules', 'commands'])
const MCP_TRANSPORT_IDS = new Set(['stdio', 'http', 'sse'])

export const SSH_MARKETPLACE_TARGET_DISABLED_REASON =
  'Marketplace Workspace targets are unavailable for SSH because remote atomic install, rollback, and ownership semantics are not supported. Select User scope instead.'

export function extensionRuntimeLabel(profile) {
  return profile === 'cloud' ? 'Cloud' : 'Desktop'
}

export function enabledExtensionSections(sections, manifest) {
  const availability = manifest?.extensions?.sections || {}
  return sections.filter(section => availability[section.id]?.enabled === true)
}

export function isConfigExtensionSection(sectionId) {
  return CONFIG_SECTION_IDS.has(sectionId)
}

export function extensionScopeOptions(manifest, workspaceHandle) {
  return (manifest?.extensions?.scopes || []).map(scope => {
    if (scope === 'workspace' && !workspaceHandle) {
      return {
        id: scope,
        label: 'Workspace',
        enabled: false,
        reason: 'Select a workspace before using Workspace scope.',
      }
    }
    return {
      id: scope,
      label: scope === 'workspace' ? 'Workspace' : 'User',
      enabled: true,
      reason: null,
    }
  })
}

export function resolveExtensionScope(manifest, scope, workspaceHandle) {
  const profile = extensionRuntimeLabel(manifest?.profile)
  const supported = manifest?.extensions?.scopes || []
  if (!supported.includes(scope)) {
    return {
      enabled: false,
      reason: `${scope === 'workspace' ? 'Workspace' : 'User'} extension configuration is unavailable in the ${profile} runtime profile.`,
      target: null,
    }
  }
  if (scope === 'workspace' && !workspaceHandle) {
    return {
      enabled: false,
      reason: 'Select a workspace before using Workspace scope.',
      target: null,
    }
  }
  return {
    enabled: true,
    reason: null,
    target:
      scope === 'workspace'
        ? { scope: 'workspace', workspace: workspaceHandle }
        : { scope: 'user' },
  }
}

export function createScopedExtensionConfigClient(
  manifest,
  scope,
  workspaceHandle,
  factory = createExtensionConfigClient,
) {
  const resolution = resolveExtensionScope(manifest, scope, workspaceHandle)
  return {
    ...resolution,
    client: resolution.enabled ? factory(resolution.target) : null,
  }
}

export function resolveMarketplaceTarget(capability, scope, workspaceHandle) {
  if (capability?.enabled !== true) {
    return {
      enabled: false,
      reason: capability?.reason || 'Marketplace is unavailable.',
      target: null,
    }
  }
  if (!(capability.targets || []).includes(scope)) {
    return {
      enabled: false,
      reason: `${
        scope === 'workspace' ? 'Workspace' : 'User'
      } Marketplace targets are unavailable in this runtime profile.`,
      target: null,
    }
  }
  if (scope === 'user') {
    return {
      enabled: true,
      reason: null,
      target: { scope: 'user' },
    }
  }
  if (!workspaceHandle) {
    return {
      enabled: false,
      reason:
        'Select a workspace before using the Workspace Marketplace target.',
      target: null,
    }
  }
  if (workspaceHandle.environmentId.startsWith('ssh:')) {
    return {
      enabled: false,
      reason: SSH_MARKETPLACE_TARGET_DISABLED_REASON,
      target: null,
    }
  }
  if (workspaceHandle.environmentId !== 'local') {
    return {
      enabled: false,
      reason:
        'Marketplace Workspace targets currently support local workspaces only.',
      target: null,
    }
  }
  return {
    enabled: true,
    reason: null,
    target: {
      scope: 'workspace',
      environmentId: workspaceHandle.environmentId,
      cwd: workspaceHandle.cwd,
    },
  }
}

export function enabledMcpTransports(manifest) {
  if (manifest?.mcp?.enabled !== true) return []
  return [
    ...new Set(
      (manifest.mcp.transports || []).filter(transport =>
        MCP_TRANSPORT_IDS.has(transport),
      ),
    ),
  ]
}

export function extensionDisabledReason(manifest) {
  const sections = Object.values(manifest?.extensions?.sections || {})
  const reasons = [
    ...new Set(
      sections
        .filter(section => section?.enabled === false && section.reason)
        .map(section => section.reason),
    ),
  ]
  return reasons.join(' ')
}
