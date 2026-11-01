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

  /** @param {{name?: string, repoUrl?: string, ref?: string}} input */
  create: input => fetchJSON('/workspaces', { method: 'POST', ...json(input) }),

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
