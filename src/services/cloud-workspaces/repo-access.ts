/**
 * Anonymous (and token-bearing) Git smart-HTTP probe.
 * The token is sent only as an Authorization header, never in the URL.
 */

export type RepoAccess = 'public' | 'auth-required' | 'not-found'

export class RepoProbeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RepoProbeError'
  }
}

const PROBE_TIMEOUT_MS = 15_000

export function classifyGitUploadPackStatus(status: number): RepoAccess {
  if (status === 200) return 'public'
  if (status === 401) return 'auth-required'
  if (status === 404) return 'not-found'
  throw new RepoProbeError(
    `Could not check repository access (${status})`,
    502,
  )
}

/** `base64(x-access-token:<token>)`, the GitHub Basic-auth username form. */
export function gitTokenBasicValue(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
}

/** git `-c` value. The token stays in this header, not in the remote URL. */
export function gitCloneAuthConfig(token: string): string {
  return `http.extraHeader=AUTHORIZATION: basic ${gitTokenBasicValue(token)}`
}

export function redactGitSecret(text: string, token?: string): string {
  if (!token) return text
  return text
    .split(token)
    .join('[redacted]')
    .split(gitTokenBasicValue(token))
    .join('[redacted]')
}

/**
 * GET `<repo>/info/refs?service=git-upload-pack` and classify the status.
 * Redirects are not followed: a 3xx to another host must not be chased.
 */
export async function probeGitRepository(
  canonicalUrl: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RepoAccess> {
  const info = new URL(canonicalUrl)
  info.pathname = `${info.pathname.replace(/\/+$/, '')}/info/refs`
  info.search = 'service=git-upload-pack'
  info.hash = ''
  const headers = new Headers({ Accept: '*/*' })
  if (token) {
    headers.set('Authorization', `Basic ${gitTokenBasicValue(token)}`)
  }
  let response: Response
  try {
    response = await fetchImpl(info, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    throw new RepoProbeError('Could not reach the repository host', 502)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new RepoProbeError(
      'Repository URL must not redirect to another host',
      400,
    )
  }
  return classifyGitUploadPackStatus(response.status)
}
