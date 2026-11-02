import { describe, expect, it, vi } from 'vitest'
import {
  classifyGitUploadPackStatus,
  gitTokenBasicValue,
  probeGitRepository,
  RepoProbeError,
} from './repo-access.js'

function response(status: number): Response {
  return new Response(null, { status })
}

describe('classifyGitUploadPackStatus', () => {
  it('maps the three GitHub smart-HTTP results', () => {
    expect(classifyGitUploadPackStatus(200)).toBe('public')
    expect(classifyGitUploadPackStatus(401)).toBe('auth-required')
    expect(classifyGitUploadPackStatus(404)).toBe('not-found')
  })

  it('rejects an unexpected status', () => {
    expect(() => classifyGitUploadPackStatus(500)).toThrow(RepoProbeError)
  })
})

describe('probeGitRepository', () => {
  const repo = 'https://github.com/acme/widgets.git'

  it('probes anonymously and does not follow a redirect', async () => {
    const fetchImpl = vi.fn(async () => response(302))
    await expect(probeGitRepository(repo, undefined, fetchImpl)).rejects.toThrow(
      /redirect/i,
    )
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe(
      'https://github.com/acme/widgets.git/info/refs?service=git-upload-pack',
    )
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
  })

  it('sends the token as Basic auth and keeps it out of the URL', async () => {
    const token = 'ghp_probe_secret'
    const fetchImpl = vi.fn(async () => response(200))
    await expect(probeGitRepository(repo, token, fetchImpl)).resolves.toBe(
      'public',
    )
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).not.toContain(token)
    expect(new Headers(init.headers).get('Authorization')).toBe(
      `Basic ${gitTokenBasicValue(token)}`,
    )
  })

  it('classifies an anonymous 401 as auth-required', async () => {
    const fetchImpl = vi.fn(async () => response(401))
    await expect(probeGitRepository(repo, undefined, fetchImpl)).resolves.toBe(
      'auth-required',
    )
  })

  it('classifies 404 as not-found', async () => {
    const fetchImpl = vi.fn(async () => response(404))
    await expect(probeGitRepository(repo, undefined, fetchImpl)).resolves.toBe(
      'not-found',
    )
  })
})
