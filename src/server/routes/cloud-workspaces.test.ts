import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../core/types.js'
import { loadCloudWorkspaceConfig } from '../../execution/providers/cloud/config.js'
import { WorkspaceContainers } from '../../execution/providers/cloud/containers.js'
import {
  CloudWorkspaceManager,
  setCloudWorkspaceManagerForTesting,
} from '../../services/cloud-workspaces/index.js'
import { CloudWorkspaceStore } from '../../services/cloud-workspaces/store.js'
import type { AuthedRequest } from '../auth/identity.js'
import {
  busyCloudWorkspaceIds,
  createCloudWorkspacesRouter,
  resolveCloudSessionBinding,
} from './cloud-workspaces.js'
import { canUseEnvironment, resolveWorkspaceDisplayLabel } from './execution.js'
import {
  createSession,
  endTurn,
  setSessionWorkspace,
  tryBeginTurn,
} from '../../session/store.js'
import { runWithRequestScope } from '../../utils/request-scope.js'

let dir: string
let manager: CloudWorkspaceManager
const prevAuth = process.env.AUTH_ENABLED

function request(email: string, role = 'user'): AuthedRequest {
  return {
    user: { email, username: email.split('@')[0], role },
    userWorkspace: `/srv/users/${email}`,
  } as AuthedRequest
}

function session(partial: Partial<Session> = {}): Session {
  return { id: 's1', messages: [], ...partial } as unknown as Session
}

beforeEach(() => {
  process.env.AUTH_ENABLED = 'true'
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-bind-'))
  manager = new CloudWorkspaceManager({
    store: new CloudWorkspaceStore(dir),
    containers: new WorkspaceContainers(
      loadCloudWorkspaceConfig({}),
      async () => ({ stdout: 'true', stderr: '', code: 0 }),
      () => {
        throw new Error('unused')
      },
    ),
  })
  setCloudWorkspaceManagerForTesting(manager)
})

afterEach(() => {
  setCloudWorkspaceManagerForTesting(null)
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
})

describe('cloud session binding', () => {
  it('creates a default workspace and returns the server-owned cwd', async () => {
    const result = await resolveCloudSessionBinding(
      request('bob@example.com'),
      manager,
      session(),
      undefined,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.handle).toEqual({
      environmentId: `cloud:${result.workspaceId}`,
      cwd: '/workspace/repo',
    })
  })

  it('restores the cloud workspace name instead of its container path', async () => {
    const workspace = await manager.ensureDefault('bob@example.com')
    manager.rename(workspace.id, 'Project Seven')

    await expect(
      resolveWorkspaceDisplayLabel(manager.handleFor(workspace.id), async () =>
        Promise.resolve('/workspace/repo'),
      ),
    ).resolves.toBe('Project Seven')
  })

  it('does not silently migrate an existing unbound chat', async () => {
    const legacy = session({
      messages: [
        { role: 'user', content: 'legacy chat' },
      ] as Session['messages'],
    })
    expect(
      await resolveCloudSessionBinding(
        request('bob@example.com'),
        manager,
        legacy,
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 409 })
    expect(manager.list('bob@example.com')).toEqual([])
  })

  it("refuses another tenant's workspace", async () => {
    const amy = await manager.ensureDefault('amy@example.com')
    const result = await resolveCloudSessionBinding(
      request('bob@example.com'),
      manager,
      session(),
      `cloud:${amy.id}`,
    )
    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  it('lets super use any workspace', async () => {
    const amy = await manager.ensureDefault('amy@example.com')
    const result = await resolveCloudSessionBinding(
      request('root@example.com', 'super'),
      manager,
      session(),
      `cloud:${amy.id}`,
    )
    expect(result.ok).toBe(true)
  })

  it('keeps a chat with history on its original workspace', async () => {
    const first = await manager.ensureDefault('bob@example.com')
    const second = manager.create({ ownerEmail: 'bob@example.com' })
    await manager.waitReady(second.id)
    const bound = session({
      messages: [{ role: 'user', content: 'hi' }] as Session['messages'],
      workspace: manager.handleFor(first.id),
    })
    expect(
      await resolveCloudSessionBinding(
        request('bob@example.com'),
        manager,
        bound,
        `cloud:${second.id}`,
      ),
    ).toMatchObject({ ok: false, status: 409 })
    expect(
      await resolveCloudSessionBinding(
        request('bob@example.com'),
        manager,
        bound,
        undefined,
      ),
    ).toMatchObject({ ok: true, workspaceId: first.id })
  })

  it('reports a deleted workspace instead of silently rebinding', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    const bound = session({
      messages: [{ role: 'user', content: 'hi' }] as Session['messages'],
      workspace: manager.handleFor(ws.id),
    })
    await manager.remove(ws.id)
    expect(
      await resolveCloudSessionBinding(
        request('bob@example.com'),
        manager,
        bound,
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 409 })
  })
})

describe('environment access under auth', () => {
  it('allows only own cloud workspaces for regular users', async () => {
    const bob = await manager.ensureDefault('bob@example.com')
    const amy = await manager.ensureDefault('amy@example.com')
    const req = request('bob@example.com')
    expect(canUseEnvironment(req, `cloud:${bob.id}`)).toBe(true)
    expect(canUseEnvironment(req, `cloud:${amy.id}`)).toBe(false)
    expect(canUseEnvironment(req, 'cloud:../../etc')).toBe(false)
    expect(canUseEnvironment(req, 'local')).toBe(false)
    expect(canUseEnvironment(req, 'ssh:prod')).toBe(false)
  })

  it('keeps host environments for super and for auth-off desktop', () => {
    expect(
      canUseEnvironment(request('root@example.com', 'super'), 'local'),
    ).toBe(true)
    process.env.AUTH_ENABLED = 'false'
    expect(canUseEnvironment({} as AuthedRequest, 'local')).toBe(true)
  })
})

describe('cloud workspace busy tracking', () => {
  it('includes scheduled and other non-durable active turns', async () => {
    const workspace = await manager.ensureDefault('bob@example.com')
    const agentHome = path.join(dir, 'agent-home')
    const active = runWithRequestScope(
      { agentHome, cwd: '/workspace/repo' },
      () => {
        const created = createSession({
          agentHome,
          cwd: '/workspace/repo',
          ownerEmail: 'bob@example.com',
        })
        setSessionWorkspace(created.id, manager.handleFor(workspace.id))
        return created
      },
    )
    expect(tryBeginTurn(active.id, agentHome)).toBe(true)
    try {
      expect(busyCloudWorkspaceIds()).toContain(workspace.id)
    } finally {
      endTurn(active.id)
    }
    expect(busyCloudWorkspaceIds()).not.toContain(workspace.id)
  })
})

describe('repository access routes', () => {
  function installProbe(
    probe: (
      url: string,
      token?: string,
    ) => Promise<'public' | 'auth-required' | 'not-found'>,
  ) {
    const next = new CloudWorkspaceManager({
      store: new CloudWorkspaceStore(dir),
      containers: manager.containers,
      probeRepo: probe,
    })
    setCloudWorkspaceManagerForTesting(next)
    return next
  }

  async function post(url: string, body: unknown) {
    const req = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as unknown as AuthedRequest
    req.method = 'POST'
    req.url = url
    req.headers = {}
    req.user = {
      email: 'bob@example.com',
      username: 'bob',
      role: 'user',
    }
    let status = 0
    let raw = ''
    const res = {
      writeHead(code: number) {
        status = code
      },
      end(data?: string) {
        raw = data ?? ''
      },
    }
    await createCloudWorkspacesRouter()(req, res as never)
    return { status, body: raw ? JSON.parse(raw) : null }
  }

  it('reports anonymous access without creating a workspace', async () => {
    const probe = vi.fn(async () => 'auth-required' as const)
    installProbe(probe)
    const result = await post('/workspaces/repo-access', {
      repoUrl: 'https://github.com/acme/private.git',
    })
    expect(result).toEqual({
      status: 200,
      body: { access: 'auth-required' },
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.json'))).toEqual(
      [],
    )
  })

  it('refuses a private repository before any record exists', async () => {
    installProbe(async () => 'auth-required')
    const missing = await post('/workspaces', {
      repoUrl: 'https://github.com/acme/private.git',
    })
    expect(missing.status).toBe(400)
    installProbe(async (_url, token) =>
      token ? 'auth-required' : 'auth-required',
    )
    const rejected = await post('/workspaces', {
      repoUrl: 'https://github.com/acme/private.git',
      gitToken: 'ghp_wrong',
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toMatch(/rejected/)
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.json'))).toEqual(
      [],
    )
  })

  it('ignores a token on a public repository', async () => {
    const probe = vi.fn(
      async (_url: string, _token?: string) => 'public' as const,
    )
    const local = installProbe(probe)
    const token = 'ghp_public_unused'
    const result = await post('/workspaces', {
      repoUrl: 'https://github.com/acme/widgets.git',
      gitToken: token,
    })
    expect(result.status).toBe(202)
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0]?.[1]).toBeUndefined()
    const recordPath = path.join(dir, `${result.body.workspace.id}.json`)
    const onDisk = fs.readFileSync(recordPath, 'utf8')
    expect(onDisk).not.toContain(token)
    expect(local.get(result.body.workspace.id)?.source).toMatchObject({
      kind: 'git',
      url: 'https://github.com/acme/widgets.git',
    })
  })
})
