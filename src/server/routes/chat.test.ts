import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { AuthedRequest } from '../auth/identity.js'
import { resolveChatWorkspaceBinding } from './chat.js'

describe('chat workspace binding', () => {
  it('ignores client workspace and environment for an authenticated tenant', () => {
    const req = {
      userWorkspace: '/srv/users/bob',
      user: { email: 'bob@example.com', username: 'bob', role: 'user' },
    } as AuthedRequest

    expect(
      resolveChatWorkspaceBinding(
        req,
        '/srv/users/alice/secret',
        'ssh:attacker-host',
        '/srv/users/bob',
      ),
    ).toEqual({
      environmentId: 'local',
      cwd: '/srv/users/bob',
    })
  })

  it('keeps legacy client-selected local and remote workspaces without auth', () => {
    const req = {} as IncomingMessage
    expect(
      resolveChatWorkspaceBinding(req, '/tmp/project', undefined, '/default'),
    ).toEqual({
      environmentId: 'local',
      cwd: '/tmp/project',
    })
    expect(
      resolveChatWorkspaceBinding(
        req,
        '/remote/project',
        'ssh:build-host',
        '/default',
      ),
    ).toEqual({
      environmentId: 'ssh:build-host',
      cwd: '/remote/project',
    })
  })
})
