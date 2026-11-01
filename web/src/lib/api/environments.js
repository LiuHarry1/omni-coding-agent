import { fetchJSON, postForm } from './_http.js'

const json = body => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** `/environments/...?environmentId=&k=v` */
const envPath = (route, environmentId, params = {}) =>
  `/environments/${route}?${new URLSearchParams({ environmentId, ...params })}`

export const environmentsApi = {
  list: () => fetchJSON('/environments'),

  resolve: input =>
    fetchJSON('/environments/resolve', {
      method: 'POST',
      ...json({ input }),
    }),

  connect: (environmentId, preferredCwd) =>
    fetchJSON('/environments/connect', {
      method: 'POST',
      ...json({ environmentId, preferredCwd }),
    }),

  listDir: (environmentId, dirPath) =>
    fetchJSON(
      envPath('fs/list', environmentId, dirPath ? { path: dirPath } : {}),
    ),

  searchFiles: (environmentId, query, dir, limit = 15, showHidden = false) =>
    fetchJSON(
      envPath('fs/search', environmentId, {
        q: query,
        dir,
        limit: String(limit),
        ...(showHidden ? { showHidden: '1' } : {}),
      }),
    ),

  getFile: (environmentId, filePath) =>
    fetchJSON(envPath('fs/file', environmentId, { path: filePath })),

  // ── Editing (same payloads as workspaceApi) ─────────────
  /** Create a new file. Fails (409) if it already exists. */
  createFile: (environmentId, path, content = '') =>
    fetchJSON('/environments/fs/file', {
      method: 'POST',
      ...json({ environmentId, path, content }),
    }),

  /** Save edits; 409 when the file changed since `mtimeMs` was read. */
  saveFile: (environmentId, path, content, mtimeMs) =>
    fetchJSON('/environments/fs/file', {
      method: 'PUT',
      ...json({ environmentId, path, content, mtimeMs }),
    }),

  createFolder: (environmentId, path) =>
    fetchJSON('/environments/fs/mkdir', {
      method: 'POST',
      ...json({ environmentId, path }),
    }),

  removeEntry: (environmentId, path) =>
    fetchJSON(envPath('fs/entry', environmentId, { path }), {
      method: 'DELETE',
    }),

  uploadFiles: (environmentId, dir, files, onProgress) => {
    const form = new FormData()
    // Fields before files: the server reads them once the body is parsed.
    form.append('environmentId', environmentId)
    form.append('dir', dir)
    for (const f of files) form.append('file', f)
    return postForm('/environments/fs/upload', form, onProgress)
  },

  /** API path streaming a file, or a directory as .tar.gz. */
  downloadPath: (environmentId, path) =>
    envPath('fs/download', environmentId, { path }),

  // ── Git (read-only) ─────────────────────────────────────
  gitStatus: (environmentId, root) =>
    fetchJSON(envPath('git/status', environmentId, { root })),

  gitDiff: (environmentId, root, path) =>
    fetchJSON(envPath('git/diff', environmentId, { root, path })),

  bindSessionWorkspace: (sessionId, workspace) =>
    fetchJSON(`/sessions/${sessionId}/workspace`, {
      method: 'POST',
      ...json(workspace),
    }),
}
