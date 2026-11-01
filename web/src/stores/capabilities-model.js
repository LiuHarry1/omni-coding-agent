export const CAPABILITIES_CONTRACT_VERSION = 1

export const EXTENSION_SECTION_IDS = [
  'skills',
  'agents',
  'rules',
  'commands',
  'plugins',
  'mcp',
  'lsp',
  'marketplace',
]

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

/**
 * Compatibility profile for a frontend talking to a server released before
 * `/capabilities`. Backend authorization remains the source of truth.
 */
export const SAFE_DESKTOP_CAPABILITIES = deepFreeze({
  version: CAPABILITIES_CONTRACT_VERSION,
  profile: 'desktop',
  disabledFeatures: [],
  workspace: {
    enabled: true,
    reason: null,
    lifecycle: 'host',
    createMethods: ['local-folder', 'ssh'],
  },
  extensions: {
    scopes: ['user', 'workspace'],
    sections: Object.fromEntries(
      EXTENSION_SECTION_IDS.map(id => [id, { enabled: true, reason: null }]),
    ),
  },
  mcp: {
    enabled: true,
    reason: null,
    transports: ['stdio', 'http', 'sse'],
  },
  marketplace: {
    enabled: true,
    reason: null,
    targets: ['user', 'workspace'],
  },
})

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid capabilities manifest: ${label} must be an object`)
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid capabilities manifest: ${label} must be one of ${allowed.join(
        ', ',
      )}`,
    )
  }
}

function assertEnumArray(value, allowed, label) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid capabilities manifest: ${label} must be an array`)
  }
  for (const item of value) assertEnum(item, allowed, label)
}

function assertAvailability(value, label) {
  assertObject(value, label)
  if (typeof value.enabled !== 'boolean') {
    throw new Error(
      `Invalid capabilities manifest: ${label}.enabled must be a boolean`,
    )
  }
  if (value.reason !== null && typeof value.reason !== 'string') {
    throw new Error(
      `Invalid capabilities manifest: ${label}.reason must be a string or null`,
    )
  }
}

export function validateCapabilitiesManifest(manifest) {
  assertObject(manifest, 'response')
  if (manifest.version !== CAPABILITIES_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported capabilities manifest version: ${String(manifest.version)}`,
    )
  }
  assertEnum(manifest.profile, ['cloud', 'desktop'], 'profile')
  if (!Array.isArray(manifest.disabledFeatures)) {
    throw new Error(
      'Invalid capabilities manifest: disabledFeatures must be an array',
    )
  }

  assertAvailability(manifest.workspace, 'workspace')
  assertEnum(manifest.workspace.lifecycle, ['managed', 'host'], 'lifecycle')
  assertEnumArray(
    manifest.workspace.createMethods,
    ['clone', 'blank', 'local-folder', 'ssh'],
    'workspace.createMethods',
  )

  assertObject(manifest.extensions, 'extensions')
  assertEnumArray(
    manifest.extensions.scopes,
    ['user', 'workspace'],
    'extensions.scopes',
  )
  assertObject(manifest.extensions.sections, 'extensions.sections')
  for (const id of EXTENSION_SECTION_IDS) {
    assertAvailability(
      manifest.extensions.sections[id],
      `extensions.sections.${id}`,
    )
  }

  assertAvailability(manifest.mcp, 'mcp')
  assertEnumArray(
    manifest.mcp.transports,
    ['stdio', 'http', 'sse'],
    'mcp.transports',
  )

  assertAvailability(manifest.marketplace, 'marketplace')
  assertEnumArray(
    manifest.marketplace.targets,
    ['user', 'workspace'],
    'marketplace.targets',
  )

  return manifest
}
