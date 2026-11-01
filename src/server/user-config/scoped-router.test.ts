import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentRegistry } from '../../execution/environment-registry.js'
import { LocalProvider } from '../../execution/providers/local/local-provider.js'
import { ShellFsPort, type ShellHost } from '../../execution/shell-fs.js'
import type {
  EnvironmentConnection,
  EnvironmentDescriptor,
  EnvironmentProvider,
  RuntimeAuth,
  RuntimePort,
  WorkerInstallInfo,
} from '../../execution/types.js'
import { WorkspaceService } from '../../execution/workspace-service.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { createExtensionConfigRouter } from './router.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const previousAppDir = process.env.AI_AGENT_DIR
const previousAuth = process.env.AUTH_ENABLED

const localShell: ShellHost = {
  spawn: script => spawn('sh', ['-c', script], { stdio: 'pipe' }),
}

class TestSshProvider implements EnvironmentProvider {
  readonly kind = 'ssh' as const
  private readonly descriptor: EnvironmentDescriptor
  private readonly port = new ShellFsPort(localShell)

  constructor(defaultCwd: string) {
    this.descriptor = {
      id: 'ssh:test-host',
      kind: 'ssh',
      displayName: 'test-host',
      defaultCwd,
      capabilities: {
        canBrowseFs: true,
        canDeployWorker: false,
        canForwardPorts: false,
        requiresOnlineConnector: false,
        credentialMode: 'none',
      },
      endpoint: {},
    }
  }

  async list(): Promise<EnvironmentDescriptor[]> {
    return [this.descriptor]
  }

  async resolve(input: string): Promise<EnvironmentDescriptor> {
    if (input !== this.descriptor.id) throw new Error('Unknown environment')
    return this.descriptor
  }

  async connect(
    environment: EnvironmentDescriptor,
  ): Promise<EnvironmentConnection> {
    return {
      id: EnvironmentRegistry.newConnectionId('ssh'),
      env: environment,
      status: 'connected',
      ensureWorker: async (): Promise<WorkerInstallInfo> => ({
        version: 'test',
        path: '',
        freshlyInstalled: false,
      }),
      openRuntime: async (
        _cwd: string,
        _auth: RuntimeAuth,
      ): Promise<RuntimePort> => {
        throw new Error('Runtime is not used in this test')
      },
      openFs: () => this.port,
    }
  }

  async disconnect(): Promise<void> {}
}

let tempRoot: string
let userHome: string
let localWorkspace: string
let sshWorkspace: string
let server: http.Server
let baseURL: string

function makePlane() {
  const registry = new EnvironmentRegistry()
  registry.register(new LocalProvider())
  registry.register(new TestSshProvider(sshWorkspace))
  return {
    registry,
    workspaces: new WorkspaceService(registry),
  }
}

async function startServer(
  options: {
    profile?: 'desktop' | 'cloud'
    canUse?: (req: http.IncomingMessage, environmentId: string) => boolean
    getPlane?: () => ReturnType<typeof makePlane>
  } = {},
): Promise<void> {
  const plane = options.getPlane ? undefined : makePlane()
  const router = createExtensionConfigRouter({
    profile: options.profile ?? 'desktop',
    getPlane: options.getPlane ?? (() => plane!),
    canUseEnvironment: options.canUse ?? (() => true),
  })
  server = http.createServer((req, res) => {
    const result = runWithRequestScope(
      { agentHome: userHome, cwd: userHome },
      () => router(req, res),
    )
    void Promise.resolve(result)
      .then(handled => {
        if (!handled && !res.headersSent) {
          res.writeHead(404)
          res.end()
        }
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  baseURL = `http://127.0.0.1:${address.port}`
}

function workspacePath(
  endpoint: string,
  workspace = localWorkspace,
  environmentId = 'local',
  extra: Record<string, string> = {},
): string {
  const query = new URLSearchParams({
    environmentId,
    cwd: workspace,
    ...extra,
  })
  return `/extension-config/workspace${endpoint}?${query}`
}

async function jsonRequest(
  pathname: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: options.method,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const raw = await response.text()
  return { status: response.status, body: raw ? JSON.parse(raw) : undefined }
}

beforeEach(async () => {
  delete process.env.AI_AGENT_DIR
  process.env.AUTH_ENABLED = 'true'
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-config-'))
  userHome = path.join(tempRoot, 'user')
  localWorkspace = path.join(tempRoot, 'local-workspace')
  sshWorkspace = path.join(tempRoot, 'ssh-workspace')
  await Promise.all(
    [userHome, localWorkspace, sshWorkspace].map(directory =>
      fs.mkdir(directory),
    ),
  )
})

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  await fs.rm(tempRoot, { recursive: true, force: true })
  if (previousAppDir === undefined) delete process.env.AI_AGENT_DIR
  else process.env.AI_AGENT_DIR = previousAppDir
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
})

describe('scoped extension config', () => {
  it('keeps the scoped user API compatible with user storage', async () => {
    await startServer()
    expect(
      (
        await jsonRequest('/extension-config/user/mkdir', {
          method: 'POST',
          body: { path: 'rules' },
        })
      ).status,
    ).toBe(200)
    const created = await jsonRequest('/extension-config/user/file', {
      method: 'POST',
      body: { path: 'rules/user.md', content: 'user scoped' },
    })
    expect(created).toMatchObject({
      status: 200,
      body: { path: 'rules/user.md', readOnly: false },
    })
    expect(
      await fs.readFile(
        path.join(userHome, '.ai-agent', 'rules', 'user.md'),
        'utf8',
      ),
    ).toBe('user scoped')
  })

  it('supports local workspace CRUD, duplicate, upload, and download', async () => {
    await startServer()
    const metadata = await jsonRequest(workspacePath(''))
    expect(metadata).toMatchObject({
      status: 200,
      body: {
        allowedRoots: ['skills', 'agents', 'rules', 'commands'],
        generation: 0,
      },
    })
    await expect(
      fs.access(path.join(localWorkspace, '.ai-agent')),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await jsonRequest(workspacePath('/mkdir'), {
      method: 'POST',
      body: { path: 'rules' },
    })
    const created = await jsonRequest(workspacePath('/file'), {
      method: 'POST',
      body: { path: 'rules/review.md', content: 'first' },
    })
    const read = await jsonRequest(
      workspacePath('/file', localWorkspace, 'local', {
        path: 'rules/review.md',
      }),
    )
    expect(read.body.content).toBe('first')

    const saved = await jsonRequest(workspacePath('/file'), {
      method: 'PUT',
      body: {
        path: 'rules/review.md',
        content: 'second',
        mtimeMs: read.body.mtimeMs,
      },
    })
    expect(saved.status).toBe(200)
    const duplicate = await jsonRequest(workspacePath('/duplicate'), {
      method: 'POST',
      body: { path: 'rules/review.md' },
    })
    expect(duplicate.body.path).toBe('rules/review-copy.md')

    const form = new FormData()
    form.append('dir', 'rules')
    form.append('file', new Blob(['uploaded']), 'upload.md')
    const upload = await fetch(`${baseURL}${workspacePath('/upload')}`, {
      method: 'POST',
      body: form,
    })
    expect(upload.status).toBe(200)

    const download = await fetch(
      `${baseURL}${workspacePath('/download', localWorkspace, 'local', {
        path: 'rules/upload.md',
      })}`,
    )
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('uploaded')

    const listed = await jsonRequest(
      workspacePath('/list', localWorkspace, 'local', { dir: 'rules' }),
    )
    expect(listed.body.entries.map((entry: any) => entry.path)).toEqual([
      'rules/review-copy.md',
      'rules/review.md',
      'rules/upload.md',
    ])
    const removed = await jsonRequest(
      workspacePath('/entry', localWorkspace, 'local', {
        path: 'rules/review.md',
      }),
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    expect(created.body.generation).toBeGreaterThan(1)
  })

  it('uses AI_AGENT_DIR for local and SSH workspace config roots', async () => {
    process.env.AI_AGENT_DIR = '.baize-agent'
    await startServer()

    for (const [environmentId, workspace] of [
      ['local', localWorkspace],
      ['ssh:test-host', sshWorkspace],
    ]) {
      const response = await jsonRequest(
        workspacePath('/mkdir', workspace, environmentId),
        {
          method: 'POST',
          body: { path: 'rules' },
        },
      )
      expect(response.status).toBe(200)
      await expect(
        fs.stat(path.join(workspace, '.baize-agent', 'rules')),
      ).resolves.toMatchObject({})
      await expect(
        fs.access(path.join(workspace, '.ai-agent')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects traversal, section escapes, and workspace symlinks', async () => {
    await startServer()
    await fs.mkdir(path.join(localWorkspace, '.ai-agent', 'skills'), {
      recursive: true,
    })
    const outside = path.join(tempRoot, 'outside.md')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(
      outside,
      path.join(localWorkspace, '.ai-agent', 'skills', 'escape.md'),
    )

    const symlink = await jsonRequest(
      workspacePath('/file', localWorkspace, 'local', {
        path: 'skills/escape.md',
      }),
    )
    expect(symlink).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
    const traversal = await jsonRequest(workspacePath('/file'), {
      method: 'POST',
      body: { path: 'rules/../../outside.md', content: 'blocked' },
    })
    expect(traversal.status).toBe(400)
    const section = await jsonRequest(workspacePath('/file'), {
      method: 'POST',
      body: { path: 'settings.json', content: 'blocked' },
    })
    expect(section).toMatchObject({
      status: 403,
      body: { code: 'EROOT' },
    })
    expect(await fs.readFile(outside, 'utf8')).toBe('outside')
  })

  it('preserves Marketplace ownership in local workspace scope', async () => {
    const skillRoot = path.join(
      localWorkspace,
      '.ai-agent',
      'skills',
      'managed',
    )
    await fs.mkdir(skillRoot, { recursive: true })
    await fs.writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: managed\ndescription: Managed\n---\nManaged.',
    )
    await fs.writeFile(
      path.join(localWorkspace, '.ai-agent', 'marketplace-lock.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            providerId: 'test-market',
            externalId: 'managed',
            kind: 'skill',
            name: 'managed',
            path: '.ai-agent/skills/managed',
            installedAt: new Date().toISOString(),
          },
        ],
      }),
    )
    await startServer()

    const listed = await jsonRequest(
      workspacePath('/list', localWorkspace, 'local', { dir: 'skills' }),
    )
    expect(listed.body.entries).toContainEqual(
      expect.objectContaining({
        path: 'skills/managed',
        readOnly: true,
        ownership: expect.objectContaining({ source: 'marketplace' }),
      }),
    )
    const write = await jsonRequest(workspacePath('/file'), {
      method: 'PUT',
      body: {
        path: 'skills/managed/SKILL.md',
        content: 'blocked',
      },
    })
    expect(write).toMatchObject({
      status: 403,
      body: { code: 'EOWNED' },
    })
  })

  it('fails closed for unauthorized and unknown handles', async () => {
    await startServer({
      canUse: (_req, environmentId) => environmentId !== 'local',
    })
    const denied = await jsonRequest(
      workspacePath('/list', localWorkspace, 'local', {
        dir: 'rules',
      }),
    )
    expect(denied.status).toBe(404)

    const unknown = await jsonRequest(
      workspacePath('/list', localWorkspace, 'ssh:unknown', {
        dir: 'rules',
      }),
    )
    expect(unknown.status).toBe(404)
    await expect(
      fs.access(path.join(localWorkspace, '.ai-agent')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects workspace scope in cloud before resolving a handle', async () => {
    const getPlane = vi.fn(() => makePlane())
    await startServer({ profile: 'cloud', getPlane })
    const response = await jsonRequest(workspacePath('/mkdir'), {
      method: 'POST',
      body: { path: 'rules' },
    })
    expect(response).toMatchObject({
      status: 403,
      body: { code: 'ESCOPE' },
    })
    const userMetadata = await jsonRequest('/extension-config/user')
    expect(userMetadata).toMatchObject({
      status: 200,
      body: { allowedRoots: ['skills', 'agents', 'rules', 'commands'] },
    })
    expect(getPlane).not.toHaveBeenCalled()
    await expect(
      fs.access(path.join(localWorkspace, '.ai-agent')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describePosix('SSH scoped extension config', () => {
  it('uses ShellFsPort for CRUD and blocks remote symlinks', async () => {
    await startServer()
    const target = (endpoint: string, extra: Record<string, string> = {}) =>
      workspacePath(endpoint, sshWorkspace, 'ssh:test-host', extra)

    await jsonRequest(target('/mkdir'), {
      method: 'POST',
      body: { path: 'agents' },
    })
    await jsonRequest(target('/file'), {
      method: 'POST',
      body: {
        path: 'agents/reviewer.md',
        content: '---\nname: reviewer\n---\nReview.',
      },
    })
    const read = await jsonRequest(
      target('/file', { path: 'agents/reviewer.md' }),
    )
    const saved = await jsonRequest(target('/file'), {
      method: 'PUT',
      body: {
        path: 'agents/reviewer.md',
        content: '---\nname: reviewer\n---\nReview carefully.',
        mtimeMs: read.body.mtimeMs,
      },
    })
    expect(saved.status).toBe(200)
    const copy = await jsonRequest(target('/duplicate'), {
      method: 'POST',
      body: { path: 'agents/reviewer.md' },
    })
    expect(copy).toMatchObject({
      status: 200,
      body: { path: 'agents/reviewer-copy.md' },
    })
    expect(
      await fs.readFile(
        path.join(sshWorkspace, '.ai-agent', 'agents', 'reviewer-copy.md'),
        'utf8',
      ),
    ).toMatch(/name: reviewer-copy/)

    const form = new FormData()
    form.append('dir', 'agents')
    form.append('file', new Blob(['remote upload']), 'notes.txt')
    const uploaded = await fetch(`${baseURL}${target('/upload')}`, {
      method: 'POST',
      body: form,
    })
    expect(uploaded.status).toBe(200)
    const downloaded = await fetch(
      `${baseURL}${target('/download', { path: 'agents/notes.txt' })}`,
    )
    expect(downloaded.status).toBe(200)
    expect(await downloaded.text()).toBe('remote upload')

    const outside = path.join(tempRoot, 'remote-outside.md')
    await fs.writeFile(outside, 'keep')
    await fs.symlink(
      outside,
      path.join(sshWorkspace, '.ai-agent', 'agents', 'link.md'),
    )
    const linked = await jsonRequest(
      target('/file', { path: 'agents/link.md' }),
    )
    expect(linked).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
    const removed = await jsonRequest(
      target('/entry', { path: 'agents/reviewer.md' }),
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    expect(await fs.readFile(outside, 'utf8')).toBe('keep')
  }, 15_000)
})
