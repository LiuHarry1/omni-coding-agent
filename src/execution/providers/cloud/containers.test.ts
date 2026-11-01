import { describe, expect, it, vi } from 'vitest'

import { loadCloudWorkspaceConfig } from './config.js'
import { WorkspaceContainers } from './containers.js'
import type { DockerRunner } from './docker-cli.js'

describe('WorkspaceContainers preflight', () => {
  it('checks the daemon and configured image', async () => {
    const run = vi.fn<DockerRunner>().mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      code: 0,
    })
    const containers = new WorkspaceContainers(
      loadCloudWorkspaceConfig({ WORKSPACE_IMAGE: 'workspace:test' }),
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
      loadCloudWorkspaceConfig({ WORKSPACE_IMAGE: 'workspace:missing' }),
      run,
    )

    await expect(containers.preflight()).rejects.toThrow(
      /workspace:missing.*npm run build:cloud/,
    )
  })
})
