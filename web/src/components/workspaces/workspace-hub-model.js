export const WORKSPACE_CREATE_METHODS = Object.freeze({
  clone: {
    id: 'clone',
    label: 'Clone repository',
    description: 'Clone an HTTP or HTTPS Git repository into Baize Cloud.',
  },
  blank: {
    id: 'blank',
    label: 'Blank cloud',
    description: 'Start with an empty managed cloud workspace.',
  },
  'local-folder': {
    id: 'local-folder',
    label: 'Local folder',
    description: 'Open a folder from this computer.',
  },
  ssh: {
    id: 'ssh',
    label: 'SSH host',
    description: 'Connect to a folder on a configured or one-off SSH host.',
  },
})

export function resolveWorkspaceCreateMethods(manifest) {
  if (!manifest?.workspace?.enabled) return []
  return (manifest.workspace.createMethods || [])
    .map(id => WORKSPACE_CREATE_METHODS[id])
    .filter(Boolean)
}

export function isWorkspaceProfileLocked(
  profile,
  authenticationEnabled,
  superUser,
) {
  return profile !== 'cloud' && authenticationEnabled && !superUser
}

export function workspaceHandleId(handle) {
  if (!handle?.environmentId || !handle?.cwd) return ''
  return `${encodeURIComponent(handle.environmentId)}::${encodeURIComponent(
    handle.cwd,
  )}`
}

export function workspaceHandleKind(handle) {
  if (handle?.environmentId?.startsWith('ssh:')) return 'ssh'
  return handle?.environmentId === 'local' ? 'local' : 'environment'
}

function pathName(path) {
  const normalized = String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  return (
    normalized.split('/').filter(Boolean).at(-1) || normalized || 'Workspace'
  )
}

function recentHandle(value) {
  const handle = value?.handle ?? value
  if (
    !handle ||
    typeof handle.environmentId !== 'string' ||
    typeof handle.cwd !== 'string'
  ) {
    return null
  }
  return {
    environmentId: handle.environmentId,
    cwd: handle.cwd,
  }
}

export function buildDesktopWorkspaceItems({
  handle,
  label,
  recentHandles = [],
}) {
  const currentId = workspaceHandleId(handle)
  const candidates = [
    ...(handle ? [{ handle, label, lastUsedAt: Number.MAX_SAFE_INTEGER }] : []),
    ...recentHandles,
  ]
  const seen = new Set()
  const items = []

  for (const candidate of candidates) {
    const candidateHandle = recentHandle(candidate)
    if (
      !candidateHandle ||
      candidateHandle.environmentId.startsWith('cloud:')
    ) {
      continue
    }
    const id = workspaceHandleId(candidateHandle)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const candidateLabel =
      typeof candidate.label === 'string' && candidate.label.trim()
        ? candidate.label
        : candidateHandle.cwd
    const kind = workspaceHandleKind(candidateHandle)
    items.push({
      id,
      handle: candidateHandle,
      kind,
      name:
        candidateLabel === candidateHandle.cwd
          ? pathName(candidateHandle.cwd)
          : candidateLabel,
      label: candidateLabel,
      current: id === currentId,
      lastUsedAt: Number.isFinite(candidate.lastUsedAt)
        ? candidate.lastUsedAt
        : 0,
    })
  }

  return items.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return right.lastUsedAt - left.lastUsedAt
  })
}

export function cloudWorkspaceSource(workspace) {
  if (workspace?.source?.kind !== 'git') {
    return {
      label: 'Cloud · Blank workspace',
      detail: 'Created from an empty Git repository',
    }
  }
  const url = String(workspace.source.url || '')
    .replace(/^https:\/\//, '')
    .replace(/\.git\/?$/, '')
  return {
    label: `Git · ${url || 'Repository'}`,
    detail: workspace.source.ref
      ? `Branch or tag: ${workspace.source.ref}`
      : 'Default branch',
  }
}

export function buildCloudWorkspaceItems(
  workspaces,
  currentId,
  pendingId = null,
) {
  return (workspaces || [])
    .map(workspace => ({
      ...workspace,
      current: workspace.id === currentId,
      pending:
        workspace.id === pendingId || workspace.status === 'provisioning',
      sourceDisplay: cloudWorkspaceSource(workspace),
    }))
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1
      if (left.pending !== right.pending) return left.pending ? -1 : 1
      return (right.lastUsedAt || 0) - (left.lastUsedAt || 0)
    })
}
