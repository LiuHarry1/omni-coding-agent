import { fetchJSON } from './_http.js'

const json = body => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** Cloud workspaces: one container + volume per workspace (`/workspaces`). */
export const cloudWorkspacesApi = {
  /** @returns {Promise<{enabled: boolean, limit?: number, workspaces: object[]}>} */
  list: () => fetchJSON('/workspaces'),

  get: id => fetchJSON(`/workspaces/${encodeURIComponent(id)}`),

  /** @param {string} repoUrl @returns {Promise<{access: 'public'|'auth-required'|'not-found'}>} */
  probeRepo: repoUrl =>
    fetchJSON('/workspaces/repo-access', {
      method: 'POST',
      ...json({ repoUrl }),
    }),

  /**
   * @param {{name?: string, repoUrl?: string, ref?: string, gitToken?: string}} input
   * `gitToken` is sent only when the caller includes it.
   */
  create: input => {
    const body = { ...input }
    if (!body.gitToken) delete body.gitToken
    return fetchJSON('/workspaces', { method: 'POST', ...json(body) })
  },

  rename: (id, name) =>
    fetchJSON(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json({ name }),
    }),

  stop: id =>
    fetchJSON(`/workspaces/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  remove: id =>
    fetchJSON(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
