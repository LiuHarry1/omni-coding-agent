import type { IncomingMessage, ServerResponse } from 'http'
import { isCloudWorkspacesEnabled } from '../../execution/providers/cloud/config.js'
import { sendJSON } from '../http.js'

export const CAPABILITIES_CONTRACT_VERSION = 1 as const

export const EXTENSION_SECTION_IDS = [
  'skills',
  'agents',
  'rules',
  'commands',
  'plugins',
  'mcp',
  'lsp',
  'marketplace',
] as const

export const DISABLABLE_FEATURE_IDS = [
  'workspaces',
  ...EXTENSION_SECTION_IDS,
] as const

export type RuntimeProfile = 'cloud' | 'desktop'
export type ExtensionSectionId = (typeof EXTENSION_SECTION_IDS)[number]
export type DisablableFeatureId = (typeof DISABLABLE_FEATURE_IDS)[number]
export type ExtensionScope = 'user' | 'workspace'
export type MCPTransport = 'stdio' | 'http' | 'sse'
export type MarketplaceTarget = 'user' | 'workspace'
export type WorkspaceLifecycle = 'managed' | 'host'
export type WorkspaceCreateMethod = 'clone' | 'blank' | 'local-folder' | 'ssh'

export type CapabilityAvailability = {
  enabled: boolean
  reason: string | null
}

export type EffectiveCapabilities = {
  version: typeof CAPABILITIES_CONTRACT_VERSION
  profile: RuntimeProfile
  disabledFeatures: DisablableFeatureId[]
  workspace: CapabilityAvailability & {
    lifecycle: WorkspaceLifecycle
    createMethods: WorkspaceCreateMethod[]
  }
  extensions: {
    scopes: ExtensionScope[]
    sections: Record<ExtensionSectionId, CapabilityAvailability>
  }
  mcp: CapabilityAvailability & {
    transports: MCPTransport[]
  }
  marketplace: CapabilityAvailability & {
    targets: MarketplaceTarget[]
  }
}

const KNOWN_FEATURES = new Set<string>(DISABLABLE_FEATURE_IDS)

export function parseDisabledFeatures(
  raw: string | undefined,
): DisablableFeatureId[] {
  if (!raw?.trim()) return []

  const values = [
    ...new Set(
      raw
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
    ),
  ]
  const unknown = values.filter(value => !KNOWN_FEATURES.has(value))
  if (unknown.length > 0) {
    throw new Error(
      `Invalid BAIZE_DISABLED_FEATURES feature id${
        unknown.length === 1 ? '' : 's'
      }: ${unknown.join(', ')}. Known feature ids: ${DISABLABLE_FEATURE_IDS.join(
        ', ',
      )}`,
    )
  }
  return values as DisablableFeatureId[]
}

export function resolveRuntimeProfile(env: NodeJS.ProcessEnv): RuntimeProfile {
  const cloudWorkspaces = isCloudWorkspacesEnabled(env)
  const derived: RuntimeProfile = cloudWorkspaces ? 'cloud' : 'desktop'
  const raw = env.BAIZE_RUNTIME_PROFILE?.trim()
  if (!raw) return derived
  if (raw !== 'cloud' && raw !== 'desktop') {
    throw new Error(
      `Invalid BAIZE_RUNTIME_PROFILE: ${JSON.stringify(
        raw,
      )}. Expected "cloud" or "desktop".`,
    )
  }
  if (raw === 'cloud' && !cloudWorkspaces) {
    throw new Error(
      'BAIZE_RUNTIME_PROFILE=cloud requires CLOUD_WORKSPACES=docker.',
    )
  }
  if (raw === 'desktop' && cloudWorkspaces) {
    throw new Error(
      'BAIZE_RUNTIME_PROFILE=desktop is incompatible with CLOUD_WORKSPACES=docker.',
    )
  }
  return raw
}

function enabled(): CapabilityAvailability {
  return { enabled: true, reason: null }
}

function unavailable(reason: string): CapabilityAvailability {
  return { enabled: false, reason }
}

function disabledByOverride(id: DisablableFeatureId): CapabilityAvailability {
  return unavailable(`Disabled by BAIZE_DISABLED_FEATURES (${id}).`)
}

export function resolveEffectiveCapabilities(
  env: NodeJS.ProcessEnv,
): EffectiveCapabilities {
  const profile = resolveRuntimeProfile(env)
  const disabledFeatures = parseDisabledFeatures(env.BAIZE_DISABLED_FEATURES)
  const disabled = new Set<DisablableFeatureId>(disabledFeatures)

  const sections = Object.fromEntries(
    EXTENSION_SECTION_IDS.map(id => {
      if (id === 'plugins' && profile === 'cloud') {
        return [
          id,
          unavailable('Plugins are unavailable in the cloud runtime profile.'),
        ]
      }
      return [id, disabled.has(id) ? disabledByOverride(id) : enabled()]
    }),
  ) as Record<ExtensionSectionId, CapabilityAvailability>

  const workspaceAvailability = disabled.has('workspaces')
    ? disabledByOverride('workspaces')
    : enabled()
  const mcpAvailability = sections.mcp
  const marketplaceAvailability = sections.marketplace

  return {
    version: CAPABILITIES_CONTRACT_VERSION,
    profile,
    disabledFeatures,
    workspace: {
      ...workspaceAvailability,
      lifecycle: profile === 'cloud' ? 'managed' : 'host',
      createMethods: workspaceAvailability.enabled
        ? profile === 'cloud'
          ? ['clone', 'blank']
          : ['local-folder', 'ssh']
        : [],
    },
    extensions: {
      scopes: profile === 'cloud' ? ['user'] : ['user', 'workspace'],
      sections,
    },
    mcp: {
      ...mcpAvailability,
      transports: mcpAvailability.enabled
        ? profile === 'cloud'
          ? ['http', 'sse']
          : ['stdio', 'http', 'sse']
        : [],
    },
    marketplace: {
      ...marketplaceAvailability,
      targets: marketplaceAvailability.enabled
        ? profile === 'cloud'
          ? ['user']
          : ['user', 'workspace']
        : [],
    },
  }
}

/**
 * Process environment is read once when the server router is created. Invalid
 * profile or feature overrides therefore fail startup instead of producing a
 * partially enabled application.
 */
export function createCapabilitiesRouter(env: NodeJS.ProcessEnv = process.env) {
  const manifest = resolveEffectiveCapabilities(env)

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname !== '/capabilities') return false
    if (req.method !== 'GET') {
      sendJSON(res, 405, { error: 'Method not allowed' })
      return true
    }
    sendJSON(res, 200, manifest)
    return true
  }
}
