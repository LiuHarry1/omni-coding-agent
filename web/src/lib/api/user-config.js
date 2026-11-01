/**
 * Restricted client for the authenticated user's `.ai-agent` resources.
 *
 * Paths are always relative to the server-owned user config root. The server
 * is responsible for rejecting paths outside the editable roots
 * (`skills/`, `agents/`, `rules/`, and `commands/`).
 */
import { apiUrl, fetchJSON, postForm } from './_http.js'

const json = body => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function normalizeUserConfigPath(path = '') {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

function scopedTarget(target) {
  if (!target || target.scope === 'user') return { scope: 'user' }
  if (
    target.scope !== 'workspace' ||
    typeof target.workspace?.environmentId !== 'string' ||
    !target.workspace.environmentId ||
    typeof target.workspace?.cwd !== 'string' ||
    !target.workspace.cwd
  ) {
    throw new TypeError(
      'Workspace extension config requires environmentId and cwd',
    )
  }
  return {
    scope: 'workspace',
    workspace: {
      environmentId: target.workspace.environmentId,
      cwd: target.workspace.cwd,
    },
  }
}

function createEndpointBuilder(target, { legacyUser = false } = {}) {
  const normalized = scopedTarget(target)
  const base = legacyUser
    ? '/user-config'
    : `/extension-config/${normalized.scope}`
  const targetParams =
    normalized.scope === 'workspace'
      ? [
          ['environmentId', normalized.workspace.environmentId],
          ['cwd', normalized.workspace.cwd],
        ]
      : []
  return (endpoint = '', params = []) => {
    const query = new URLSearchParams([...targetParams, ...params])
    const suffix = query.size ? `?${query.toString()}` : ''
    return `${base}${endpoint}${suffix}`
  }
}

export function isMtimeConflict(error) {
  return error?.status === 409
}

/**
 * Build an ExtensionConfigClient for either the authenticated user or one
 * authorized workspace handle. Methods intentionally retain the response
 * shapes of the legacy user-config client.
 */
export function createExtensionConfigClient(
  target = { scope: 'user' },
  options = {},
) {
  const normalizedTarget = scopedTarget(target)
  const endpoint = createEndpointBuilder(normalizedTarget, options)
  const pathParam = path => [['path', normalizeUserConfigPath(path)]]
  const listDirectory = path =>
    fetchJSON(endpoint('/list', [['dir', normalizeUserConfigPath(path)]]))
  const listConfig = async (path, { recursive = false } = {}) => {
    const root = await listDirectory(path)
    if (!recursive) return root

    const entries = [...(root.entries || [])]
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (!entry?.isDir) continue
      const child = await listDirectory(entry.path)
      entries.push(...(child.entries || []))
    }
    return { ...root, entries }
  }

  return {
    target: normalizedTarget,

    metadata: () => fetchJSON(endpoint()),

    /** List a folder. `recursive` is useful for a Skill package file tree. */
    list: listConfig,

    read: path => fetchJSON(endpoint('/file', pathParam(path))),

    /** Create a new text file. Fails when it already exists. */
    create: (path, content = '') =>
      fetchJSON(endpoint('/file'), {
        method: 'POST',
        ...json({ path: normalizeUserConfigPath(path), content }),
      }),

    /** Save with optimistic concurrency using the mtime returned by `read`. */
    save: (path, content, mtimeMs) =>
      fetchJSON(endpoint('/file'), {
        method: 'PUT',
        ...json({
          path: normalizeUserConfigPath(path),
          content,
          ...(mtimeMs == null ? {} : { mtimeMs }),
        }),
      }),

    mkdir: path =>
      fetchJSON(endpoint('/mkdir'), {
        method: 'POST',
        ...json({ path: normalizeUserConfigPath(path) }),
      }),

    remove: path =>
      fetchJSON(endpoint('/entry', pathParam(path)), { method: 'DELETE' }),

    /**
     * Duplicate a file or package. When `name` is omitted, the server
     * chooses a collision-free editable name and returns its path.
     */
    duplicate: (path, name) =>
      fetchJSON(endpoint('/duplicate'), {
        method: 'POST',
        ...json({
          path: normalizeUserConfigPath(path),
          ...(name ? { name: normalizeUserConfigPath(name) } : {}),
        }),
      }),

    upload: (dir, files, onProgress) => {
      const form = new FormData()
      form.append('dir', normalizeUserConfigPath(dir))
      for (const file of files) form.append('file', file)
      return postForm(endpoint('/upload'), form, onProgress)
    },

    downloadPath: path => endpoint('/download', pathParam(path)),
    downloadUrl: path => apiUrl(endpoint('/download', pathParam(path))),
  }
}

/** Compatibility client retained for existing sections and callers. */
export const userConfigApi = createExtensionConfigClient(
  { scope: 'user' },
  { legacyUser: true },
)
