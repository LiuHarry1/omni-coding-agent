/**
 * Coding-agent HTTP client. Sessions, chat streaming, and any future
 * settings/MCP endpoints live here. Independent of the workspace module.
 */
import { fetchJSON, withAuth, apiUrl } from './_http.js'

export const agentApi = {
  listSessions: () => fetchJSON('/sessions'),
  createSession: () => fetchJSON('/sessions', { method: 'POST' }),
  deleteSession: id =>
    fetch(apiUrl(`/sessions/${id}`), withAuth({ method: 'DELETE' })),
  getSessionMessages: id => fetchJSON(`/sessions/${id}/messages`),
  listSessionTasks: id => fetchJSON(`/sessions/${id}/tasks`),
  stopSessionTask: (sessionId, taskId) =>
    fetchJSON(`/sessions/${sessionId}/tasks/${taskId}/stop`, {
      method: 'POST',
    }),

  getSlashCommands: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/slash-commands${qs}`)
  },

  getAgents: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/agents${qs}`)
  },

  getSkills: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/skills${qs}`)
  },

  getPlugins: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/plugins${qs}`)
  },

  getMarketplaceProviders: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/marketplaces/providers${qs}`)
  },

  marketplaceLogin: (providerId, credentials, workspace) => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/auth/login${qs}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      },
    )
  },

  marketplaceLogout: (providerId, workspace) => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/auth/logout${qs}`,
      { method: 'POST' },
    )
  },

  getMarketplaceCatalog: (providerId, params = {}) => {
    const qs = new URLSearchParams()
    qs.set('kind', params.kind || 'skill')
    if (params.q) qs.set('q', params.q)
    if (params.page) qs.set('page', String(params.page))
    if (params.perPage) qs.set('perPage', String(params.perPage))
    if (params.workspace) qs.set('workspace', params.workspace)
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/catalog?${qs}`,
    )
  },

  getMarketplaceEnvSchema: (providerId, id, workspace) => {
    const qs = new URLSearchParams({ kind: 'skill', id })
    if (workspace) qs.set('workspace', workspace)
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/env-schema?${qs}`,
    )
  },

  installMarketplaceItem: (providerId, item, workspace, options = {}) => {
    const qs = new URLSearchParams({
      kind: item.kind,
      id: item.externalId,
    })
    if (workspace) qs.set('workspace', workspace)
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/install?${qs}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Catalog `version` is a semantic package version (for example 1.0.0),
        // while Demeter's historical download endpoint expects an integer
        // version_number. A normal install always downloads the published
        // latest artifact; an explicit version picker can send versionNumber
        // in a future UI.
        body: JSON.stringify({
          ...(options.confirmConflicts ? { confirmConflicts: true } : {}),
        }),
      },
    )
  },

  previewMarketplaceBundle: (providerId, item, workspace) => {
    const qs = new URLSearchParams({
      kind: 'bundle',
      id: item.externalId,
    })
    if (workspace) qs.set('workspace', workspace)
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/preview?${qs}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
  },

  uninstallMarketplaceItem: (providerId, item, workspace) => {
    const qs = new URLSearchParams({
      kind: item.kind,
      id: item.externalId,
    })
    if (workspace) qs.set('workspace', workspace)
    return fetchJSON(
      `/marketplaces/${encodeURIComponent(providerId)}/uninstall?${qs}`,
      { method: 'DELETE' },
    )
  },

  /** MCP server statuses + their tool lists for the workspace. */
  getMcp: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/mcp${qs}`)
  },

  /** Configured / running LSP servers for the workspace. */
  getLsp: workspace => {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
    return fetchJSON(`/lsp${qs}`)
  },

  postChat: (body, signal) =>
    fetch(
      apiUrl('/chat'),
      withAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
    ),

  streamSessionLive: (sessionId, signal) =>
    fetch(
      apiUrl(`/sessions/${encodeURIComponent(sessionId)}/live`),
      withAuth({ signal }),
    ),

  getRun: runId => fetchJSON(`/runs/${encodeURIComponent(runId)}`),

  streamRun: (runId, afterSeq, signal) => {
    const qs =
      Number.isFinite(afterSeq) && afterSeq > 0
        ? `?after_seq=${encodeURIComponent(String(afterSeq))}`
        : ''
    return fetch(
      apiUrl(`/runs/${encodeURIComponent(runId)}/stream${qs}`),
      withAuth({
        headers:
          Number.isFinite(afterSeq) && afterSeq > 0
            ? { 'Last-Event-ID': String(afterSeq) }
            : undefined,
        signal,
      }),
    )
  },

  cancelRun: runId =>
    fetchJSON(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),

  /**
   * Upload composer attachments before /chat (OpenClaw claim-check).
   * Creates a session when sessionId is null. Returns durable /sessions/.../uploads URLs.
   * @param {string|null} sessionId
   * @param {File[]} files
   * @returns {Promise<{ session_id: string, urls: string[], files: Array<{url:string,filename:string,mediaType:string,kind:string,sizeBytes:number}> }>}
   */
  uploadChatAttachments: (sessionId, files) => {
    const form = new FormData()
    for (const f of files) form.append('file', f)
    const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    return fetchJSON(`/chat/uploads${qs}`, {
      method: 'POST',
      body: form,
    })
  },

  answerQuestion: body =>
    fetchJSON('/ask_user_question/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  answerCanUseTool: body =>
    fetchJSON('/can_use_tool/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  approvePlan: body =>
    fetchJSON('/plan/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  setSessionMode: body =>
    fetchJSON('/session/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  setSessionAgent: body =>
    fetchJSON('/session/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Abort a single in-flight tool (e.g. Explore subagent) by tool_use_id. */
  abortTool: body =>
    fetchJSON('/tool/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Stop the in-flight chat turn; SSE stays open until the server ends it. */
  cancelChat: sessionId =>
    fetchJSON('/chat/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }),

  getScheduledTasks: (sessionId, workspace) => {
    const params = new URLSearchParams()
    if (sessionId) params.set('session_id', sessionId)
    if (workspace) params.set('workspace', workspace)
    const qs = params.toString()
    return fetchJSON(`/scheduled-tasks${qs ? `?${qs}` : ''}`)
  },
  createScheduledTask: body =>
    fetchJSON('/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteScheduledTask: (id, sessionId, workspace) => {
    const params = new URLSearchParams({ session_id: sessionId })
    if (workspace) params.set('workspace', workspace)
    return fetchJSON(`/scheduled-tasks/${encodeURIComponent(id)}?${params}`, {
      method: 'DELETE',
    })
  },

  getBrowserLock: sessionId =>
    fetchJSON(
      sessionId
        ? `/browser/lock?session_id=${encodeURIComponent(sessionId)}`
        : '/browser/lock',
    ),
  setBrowserLock: (userHasControl, sessionId) =>
    fetchJSON('/browser/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userHasControl,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    }),
}
