import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  registerSessionLocation,
  unregisterSessionLocation,
} from '../../core/session-paths.js'
import { getDefaultWorkspace } from '../../core/workspace.js'
import { loadCloudWorkspaceConfig } from '../../execution/providers/cloud/config.js'
import { WorkspaceContainers } from '../../execution/providers/cloud/containers.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { setCloudWorkspaceManagerForTesting } from './index.js'
import { CloudWorkspaceManager } from './manager.js'
import { CloudWorkspaceStore } from './store.js'
import {
  cloudSandboxSeesAgentHome,
  cloudSandboxSeesSessionFiles,
  filterCloudMCPServers,
  resolveTurnWorkspaceScope,
} from './turn-scope.js'

describe('cloud turn scope', () => {
  it('separates request-scoped configuration from container tools', () => {
    const home = path.resolve('/srv/users/alice')
    runWithRequestScope({ agentHome: home, cwd: home }, () => {
      expect(
        resolveTurnWorkspaceScope(
          {
            environmentId: 'cloud:abcdef0123456789',
            cwd: '/workspace/repo',
          },
          '/workspace/repo',
        ),
      ).toMatchObject({
        agentHome: home,
        environmentId: 'cloud:abcdef0123456789',
        workspaceRoot: '/workspace/repo',
        executionCwd: '/workspace/repo',
        requestedCwd: '/workspace/repo',
        cwdDrifted: false,
        toolCwd: '/workspace/repo',
        extensionCwd: home,
        settingsCwd: home,
        extensionRoot: path.join(home, '.ai-agent'),
        cloudWorkspaceId: 'abcdef0123456789',
        remote: true,
      })
    })
  })

  it('uses the remote binding when an entry point supplies agentHome as cwd', () => {
    const home = path.resolve('/srv/users/alice')
    runWithRequestScope({ agentHome: home, cwd: home }, () => {
      const scope = resolveTurnWorkspaceScope(
        {
          environmentId: 'cloud:abcdef0123456789',
          cwd: '/workspace/repo',
        },
        home,
      )
      expect(scope).toMatchObject({
        requestedCwd: home,
        workspaceRoot: '/workspace/repo',
        executionCwd: '/workspace/repo',
        toolCwd: '/workspace/repo',
        cwdDrifted: true,
      })
    })
  })

  it('allows a remote execution cwd below the stable workspace root', () => {
    const home = path.resolve('/srv/users/alice')
    runWithRequestScope({ agentHome: home, cwd: home }, () => {
      const scope = resolveTurnWorkspaceScope(
        {
          environmentId: 'cloud:abcdef0123456789',
          cwd: '/workspace/repo',
        },
        '/workspace/repo/packages/web',
      )
      expect(scope).toMatchObject({
        workspaceRoot: '/workspace/repo',
        executionCwd: '/workspace/repo/packages/web',
        cwdDrifted: false,
      })
    })
  })

  it('fails closed without a request scope', () => {
    const previousAuth = process.env.AUTH_ENABLED
    process.env.AUTH_ENABLED = 'true'
    try {
      expect(() =>
        resolveTurnWorkspaceScope(
          {
            environmentId: 'cloud:abcdef0123456789',
            cwd: '/workspace/repo',
          },
          '/workspace/repo',
        ),
      ).toThrow(/request-scoped agent home/)
    } finally {
      if (previousAuth === undefined) delete process.env.AUTH_ENABLED
      else process.env.AUTH_ENABLED = previousAuth
    }
  })

  it('keeps local and SSH control-plane roots unchanged', () => {
    expect(
      resolveTurnWorkspaceScope(
        { environmentId: 'local', cwd: '/project' },
        '/project',
      ),
    ).toMatchObject({
      toolCwd: '/project',
      extensionCwd: '/project',
      settingsCwd: '/project',
      remote: false,
    })
    expect(
      resolveTurnWorkspaceScope(
        { environmentId: 'ssh:dev', cwd: '/srv/project' },
        '/srv/project',
      ),
    ).toMatchObject({
      toolCwd: '/srv/project',
      extensionCwd: getDefaultWorkspace(),
      settingsCwd: getDefaultWorkspace(),
      remote: true,
    })
  })
})

describe('cloudSandboxSeesAgentHome', () => {
  const id = 'abcdef0123456789'
  const workspace = { environmentId: `cloud:${id}`, cwd: '/workspace/repo' }
  let dir: string

  function install(env: NodeJS.ProcessEnv): void {
    const store = new CloudWorkspaceStore(dir)
    store.put({
      version: 1,
      id,
      ownerEmail: 'Alice@Example.com',
      name: 'repo',
      source: { kind: 'empty' },
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    })
    setCloudWorkspaceManagerForTesting(
      new CloudWorkspaceManager({
        store,
        containers: new WorkspaceContainers(
          loadCloudWorkspaceConfig(env),
          async () => ({ stdout: '', stderr: '', code: 0 }),
        ),
      }),
    )
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sees-home-'))
  })

  afterEach(() => {
    setCloudWorkspaceManagerForTesting(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const mounted = {
    WORKSPACES_HOST_PATH: '/var/workspaces',
    USERS_ROOT: '/workspace/users',
  }

  it('is true for the owner whose .ai-agent is mounted', () => {
    install(mounted)
    expect(
      cloudSandboxSeesAgentHome(
        workspace,
        '/workspace/users/alice_example.com',
      ),
    ).toBe(true)
  })

  it('is false for another user in the same workspace', () => {
    install(mounted)
    expect(
      cloudSandboxSeesAgentHome(workspace, '/workspace/users/root_example.com'),
    ).toBe(false)
  })

  it('is false without the mount configuration', () => {
    install({ WORKSPACES_HOST_PATH: '/var/workspaces' })
    expect(
      cloudSandboxSeesAgentHome(
        workspace,
        '/workspace/users/alice_example.com',
      ),
    ).toBe(false)
  })

  it('is false for unknown workspaces, SSH and local', () => {
    install(mounted)
    const home = '/workspace/users/alice_example.com'
    expect(
      cloudSandboxSeesAgentHome(
        { environmentId: 'cloud:0000000000000000', cwd: '/workspace/repo' },
        home,
      ),
    ).toBe(false)
    expect(
      cloudSandboxSeesAgentHome(
        { environmentId: 'ssh:dev', cwd: '/srv' },
        home,
      ),
    ).toBe(false)
    expect(cloudSandboxSeesAgentHome(undefined, home)).toBe(false)
  })

  it('checks session files against the session agent home', () => {
    install(mounted)
    const session = 'sees-session-files'
    try {
      expect(cloudSandboxSeesSessionFiles(workspace, session)).toBe(false)
      registerSessionLocation(session, {
        projectKey: 'k',
        agentHome: '/workspace/users/alice_example.com',
      })
      expect(cloudSandboxSeesSessionFiles(workspace, session)).toBe(true)
      registerSessionLocation(session, {
        projectKey: 'k',
        agentHome: '/workspace/users/root_example.com',
      })
      expect(cloudSandboxSeesSessionFiles(workspace, session)).toBe(false)
    } finally {
      unregisterSessionLocation(session)
    }
  })
})

describe('cloud MCP policy', () => {
  it('keeps HTTP/SSE and drops stdio or non-HTTP transports', () => {
    const result = filterCloudMCPServers({
      docs: { url: 'https://mcp.example.com/mcp', transport: 'http' },
      events: { url: 'http://mcp.example.com/sse', transport: 'sse' },
      implicit: { url: 'https://mcp.example.com/default' },
      local: { command: 'node', args: ['server.js'] },
      file: { url: 'file:///tmp/mcp.sock' },
    })

    expect(result.servers).toEqual({
      docs: { url: 'https://mcp.example.com/mcp', transport: 'http' },
      events: { url: 'http://mcp.example.com/sse', transport: 'sse' },
      implicit: { url: 'https://mcp.example.com/default' },
    })
    expect(result.dropped).toEqual(['local', 'file'])
  })
})
