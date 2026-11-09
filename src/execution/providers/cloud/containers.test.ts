import { describe, expect, it, vi } from 'vitest'

import { loadCloudWorkspaceConfig } from './config.js'
import { WorkspaceContainers } from './containers.js'
import type { DockerRunner } from './docker-cli.js'

const MOUNT_ENV = {
  WORKSPACES_HOST_PATH: '/var/workspaces',
  USERS_ROOT: '/workspace/users',
}

describe('WorkspaceContainers preflight', () => {
  it('checks the daemon and configured image', async () => {
    const run = vi.fn<DockerRunner>().mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      code: 0,
    })
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({
        ...MOUNT_ENV,
        WORKSPACE_IMAGE: 'workspace:test',
      }),
      run,
    )

    await containers.preflight()

    expect(run).toHaveBeenNthCalledWith(
      1,
      ['version', '--format', '{{.Server.Version}}'],
      { timeoutMs: 10_000 },
    )
    expect(run).toHaveBeenNthCalledWith(
      2,
      ['image', 'inspect', 'workspace:test'],
      { timeoutMs: 10_000 },
    )
  })

  it('reports a missing image with the build command', async () => {
    const run = vi
      .fn<DockerRunner>()
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '', code: 0 })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'No such image',
        code: 1,
      })
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({
        ...MOUNT_ENV,
        WORKSPACE_IMAGE: 'workspace:missing',
      }),
      run,
    )

    await expect(containers.preflight()).rejects.toThrow(
      /workspace:missing.*npm run build:cloud/,
    )
  })

  it('fails startup when USERS_ROOT is not set', async () => {
    const run = vi.fn<DockerRunner>()
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({ WORKSPACES_HOST_PATH: '/var/workspaces' }),
      run,
    )

    await expect(containers.preflight()).rejects.toThrow(
      /USERS_ROOT is not set/,
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('fails startup when WORKSPACES_HOST_PATH is not set', async () => {
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({ USERS_ROOT: '/workspace/users' }),
      vi.fn<DockerRunner>(),
    )

    await expect(containers.preflight()).rejects.toThrow(/WORKSPACES_HOST_PATH/)
  })
})

describe('cloud users root', () => {
  it('normalizes USERS_ROOT the same way the agent resolves it', () => {
    expect(
      loadCloudWorkspaceConfig({ USERS_ROOT: ' /workspace//users/ ' })
        .usersRoot,
    ).toBe('/workspace/users')
  })

  it('rejects a relative or escaping USERS_ROOT', () => {
    expect(() => loadCloudWorkspaceConfig({ USERS_ROOT: 'users' })).toThrow(
      /Invalid USERS_ROOT/,
    )
    expect(() =>
      loadCloudWorkspaceConfig({ USERS_ROOT: '/workspace/../etc' }),
    ).toThrow(/Invalid USERS_ROOT/)
  })

  it('maps host paths one-to-one when the agent runs on the Docker host', () => {
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({
        WORKSPACES_HOST_PATH: '/Users/dev/cloud-dev',
        WORKSPACES_ROOT: '/Users/dev/cloud-dev',
        USERS_ROOT: '/Users/dev/cloud-dev/users',
      }),
      vi.fn<DockerRunner>(),
    )
    expect(containers.userBindMount('local@localhost')).toBe(
      'type=bind,src=/Users/dev/cloud-dev/users/local_localhost/.ai-agent,dst=/Users/dev/cloud-dev/users/local_localhost/.ai-agent',
    )
  })

  it('refuses a USERS_ROOT outside WORKSPACES_ROOT', () => {
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({
        WORKSPACES_HOST_PATH: '/var/workspaces',
        USERS_ROOT: '/home/users',
      }),
      vi.fn<DockerRunner>(),
    )
    expect(() => containers.userBindMount('bob@example.com')).toThrow(
      /outside WORKSPACES_ROOT/,
    )
  })

  it('mounts at USERS_ROOT even when it is the volume root', () => {
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({
        WORKSPACES_HOST_PATH: '/var/workspaces',
        USERS_ROOT: '/workspace',
      }),
      vi.fn<DockerRunner>(),
    )
    expect(containers.userBindMount('bob@example.com')).toBe(
      'type=bind,src=/var/workspaces/bob_example.com/.ai-agent,dst=/workspace/bob_example.com/.ai-agent',
    )
  })
})
