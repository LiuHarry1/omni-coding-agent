/**
 * Workspace HTTP client. Talks to the `/workspace/*` module on the server,
 * which is itself decoupled from the agent/session/MCP routes.
 *
 * Owned by the workspace IDE feature. Nothing in `agent.js` should import
 * this file, and nothing here should import from `agent.js` — the only
 * shared code is the tiny `fetchJSON` helper.
 */
import { fetchJSON, apiUrl, withAuth } from './_http.js'
import { authHeader, handleUnauthorized } from '../auth.js'
import { fileName } from '../utils.js'

const json = body => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const workspaceApi = {
  getRoot: () => fetchJSON('/workspace'),

  reset: (confirmation = 'RESET') =>
    fetchJSON('/workspace/reset', {
      method: 'POST',
      ...json({ confirmation }),
    }),

  listDir: (dir, showHidden = false) => {
    const params = new URLSearchParams({ dir })
    if (showHidden) params.set('showHidden', '1')
    return fetchJSON(`/workspace/list?${params}`)
  },

  /** @-mention autocomplete — fuzzy search over workspace files. */
  searchFiles: (q, dir, limit = 15, showHidden = false) => {
    const params = new URLSearchParams({
      q,
      limit: String(limit),
    })
    if (dir) params.set('dir', dir)
    if (showHidden) params.set('showHidden', '1')
    return fetchJSON(`/workspace/search?${params}`)
  },

  getFile: path =>
    fetchJSON(`/workspace/file?path=${encodeURIComponent(path)}`),

  /** Create a new file. Fails (409) if it already exists. */
  createFile: (path, content = '') =>
    fetchJSON('/workspace/file', {
      method: 'POST',
      ...json({ path, content }),
    }),

  /**
   * Save edits to an existing file. Pass `mtimeMs` (from a prior read) to
   * enable optimistic-concurrency: the server returns 409 if the file was
   * modified externally since then.
   */
  saveFile: (path, content, mtimeMs) =>
    fetchJSON('/workspace/file', {
      method: 'PUT',
      ...json({ path, content, mtimeMs }),
    }),

  createFolder: path =>
    fetchJSON('/workspace/mkdir', { method: 'POST', ...json({ path }) }),

  removeEntry: path =>
    fetchJSON(`/workspace/entry?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  // ── Binary transfer ─────────────────────────────────────
  /**
   * Upload one or more files into `dir`. Uses XHR (not fetch) so we can
   * surface upload progress — fetch has no upload-progress event.
   *
   * @param {string} dir       Absolute target directory.
   * @param {FileList|File[]} files
   * @param {(pct:number)=>void} [onProgress]  0–100.
   * @returns {Promise<{dir:string, uploaded:Array<{name,path,size}>}>}
   */
  uploadFiles: (dir, files, onProgress) =>
    new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('dir', dir)
      for (const f of files) form.append('file', f)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', apiUrl('/workspace/upload'))
      const auth = authHeader()
      if (auth.Authorization)
        xhr.setRequestHeader('Authorization', auth.Authorization)
      xhr.upload.onprogress = e => {
        if (onProgress && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
      xhr.onload = () => {
        let body = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body ?? {})
        } else {
          const err = new Error(
            `HTTP ${xhr.status}${body?.error ? `: ${body.error}` : ''}`,
          )
          err.status = xhr.status
          reject(err)
        }
      }
      xhr.onerror = () => reject(new Error('Upload failed (network error)'))
      xhr.send(form)
    }),

  /** URL that streams a file (or a zip of a directory) as a download. */
  downloadUrl: path =>
    apiUrl(`/workspace/download?path=${encodeURIComponent(path)}`),

  // ── Git (read-only) ─────────────────────────────────────
  gitStatus: () => fetchJSON('/workspace/git/status'),
  gitDiff: path =>
    fetchJSON(`/workspace/git/diff?path=${encodeURIComponent(path)}`),
}

function filenameFromContentDisposition(header) {
  if (!header) return null
  const star = header.match(/filename\*=UTF-8''([^;\n]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {}
  }
  const quoted = header.match(/filename="([^"]+)"/i)
  if (quoted) return quoted[1]
  const plain = header.match(/filename=([^;\n]+)/i)
  if (plain) return plain[1].trim()
  return null
}

/** Fetch a file/dir download with auth headers (anchor href can't send them). */
async function fetchDownloadBlob(path) {
  const res = await fetch(workspaceApi.downloadUrl(path), withAuth())
  if (res.status === 401) {
    handleUnauthorized()
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error ? `: ${body.error}` : ''
    } catch {}
    const err = new Error(`HTTP ${res.status}${detail}`)
    err.status = res.status
    throw err
  }
  const blob = await res.blob()
  const name =
    filenameFromContentDisposition(res.headers.get('Content-Disposition')) ||
    fileName(path)
  return { blob, name }
}

/**
 * Trigger a browser download for `path` (file or directory-as-zip) by
 * fetching with auth and clicking a transient anchor. Kept out of
 * `workspaceApi` because it touches the DOM rather than the network.
 */
export async function triggerDownload(path) {
  const { blob, name } = await fetchDownloadBlob(path)
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Authenticated blob URL for inline previews (e.g. images). Caller must
 * revoke the URL when done.
 */
export async function fetchAuthenticatedBlobUrl(path) {
  const { blob } = await fetchDownloadBlob(path)
  return URL.createObjectURL(blob)
}

/**
 * Fetch an authenticated API resource (session upload/browser artifact or
 * workspace preview) and expose it as a short-lived object URL.
 */
export async function fetchAuthenticatedResourceBlobUrl(resourcePath) {
  const res = await fetch(apiUrl(resourcePath), withAuth())
  if (res.status === 401) {
    handleUnauthorized()
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return URL.createObjectURL(await res.blob())
}
