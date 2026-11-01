/**
 * Shared low-level fetch helper. Lives below both feature modules; neither
 * `agent.js` nor `workspace.js` imports the other, but both import this.
 *
 * When auth is enabled it injects the bearer token on every request and, on
 * a 401, clears the stale token and bounces to the SSO login.
 */
import { authHeader, handleUnauthorized } from '../auth.js'

/**
 * Reverse-proxy mount used by KnowBot nginx (`/code/` → this agent).
 * Keep in sync with src/server/public-base.ts.
 */
const PUBLIC_MOUNT = '/code'

/**
 * When the SPA is opened under PUBLIC_MOUNT, API calls must stay on that
 * prefix (the gateway strips it before forwarding). Direct :8090 / Vite
 * dev stay at origin root.
 */
function inferredPublicBase() {
  const p = globalThis.location?.pathname || ''
  if (p === PUBLIC_MOUNT || p.startsWith(`${PUBLIC_MOUNT}/`))
    return PUBLIC_MOUNT
  return ''
}

/**
 * Resolve the agent backend base URL. Empty string = same-origin (the
 * default, identical to the old hard-coded relative paths). This is what
 * lets the frontend be deployed independently of the backend:
 *
 *   - runtime  : window.__APP_CONFIG__.apiBase (set by app-config.js, so
 *                ONE web image can point at any backend without a rebuild)
 *   - build    : import.meta.env.VITE_API_BASE (handy for `npm run dev`)
 *   - inferred : /code when the page URL is under that prefix
 *   - fallback : "" → same-origin
 */
function apiBase() {
  const runtime = globalThis.__APP_CONFIG__?.apiBase
  if (typeof runtime === 'string' && runtime) return runtime.replace(/\/$/, '')
  const build = import.meta.env?.VITE_API_BASE
  if (typeof build === 'string' && build) return build.replace(/\/$/, '')
  return inferredPublicBase()
}

/** Prefix an absolute API path (e.g. "/chat") with the backend base URL. */
export function apiUrl(path) {
  return apiBase() + path
}

/** Merge the auth header into a fetch init's headers (auth-off → no-op). */
export function withAuth(options = {}) {
  const auth = authHeader()
  if (!auth.Authorization) return options
  return { ...options, headers: { ...(options.headers || {}), ...auth } }
}

/**
 * POST a FormData body. Uses XHR (not fetch) so callers get upload progress —
 * fetch has no upload-progress event.
 *
 * @param {string} path
 * @param {FormData} form
 * @param {(pct:number)=>void} [onProgress]  0–100.
 */
export function postForm(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(path))
    const auth = authHeader()
    if (auth.Authorization)
      xhr.setRequestHeader('Authorization', auth.Authorization)
    xhr.upload.onprogress = e => {
      if (onProgress && e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status === 401) handleUnauthorized()
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
  })
}

export async function fetchJSON(path, options) {
  const res = await fetch(apiUrl(path), withAuth(options))
  if (res.status === 401) {
    handleUnauthorized()
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
  return res.json()
}
