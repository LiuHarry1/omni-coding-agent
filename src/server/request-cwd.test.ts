import type { IncomingMessage } from 'http'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthedRequest } from './auth/identity.js'
import { resolveStatusWorkspaceHandle } from './request-cwd.js'

const previousAuth = process.env.AUTH_ENABLED

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
})

function request(userWorkspace = '/srv/users/alice'): IncomingMessage {
  return { userWorkspace } as unknown as AuthedRequest
}

describe('status workspace handles', () => {
  it('keeps an explicit Cloud handle instead of substituting the AUTH pin', () => {
    process.env.AUTH_ENABLED = 'true'

    expect(
      resolveStatusWorkspaceHandle(
        request(),
        '/lsp?environmentId=cloud%3Aabcdef0123456789&cwd=%2Fworkspace%2Frepo',
      ),
    ).toEqual({
      environmentId: 'cloud:abcdef0123456789',
      cwd: '/workspace/repo',
    })
  })

  it('keeps legacy status requests local and pinned under AUTH', () => {
    process.env.AUTH_ENABLED = 'true'

    expect(
      resolveStatusWorkspaceHandle(request(), '/lsp?workspace=/workspace/repo'),
    ).toEqual({
      environmentId: 'local',
      cwd: '/srv/users/alice',
    })
  })

  it('requires cwd when an environment is explicit', () => {
    expect(() =>
      resolveStatusWorkspaceHandle(request(), '/lsp?environmentId=ssh%3Adev'),
    ).toThrow(/environmentId and cwd/)
  })
})
