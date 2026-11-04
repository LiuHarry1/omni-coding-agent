import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getOrCreate } = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
}))

vi.mock('./bootstrap.js', () => ({
  getExecutionPlane: () => ({ runtimes: { getOrCreate } }),
}))

import { WorkspaceWarmupCoordinator } from './prewarm.js'

describe('WorkspaceWarmupCoordinator', () => {
  beforeEach(() => {
    getOrCreate.mockReset()
  })

  it('shares concurrent warmups for the same workspace', async () => {
    let release!: () => void
    getOrCreate.mockReturnValue(
      new Promise<void>(resolve => {
        release = resolve
      }),
    )
    const coordinator = new WorkspaceWarmupCoordinator()

    const handle = {
      environmentId: 'cloud:workspace-1',
      cwd: '/workspace/repo',
    }
    const first = coordinator.warm(handle)
    const second = coordinator.warm(handle)

    expect(getOrCreate).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
  })

  it('fails softly and allows a later retry', async () => {
    getOrCreate
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined)
    const coordinator = new WorkspaceWarmupCoordinator()

    const handle = {
      environmentId: 'cloud:workspace-1',
      cwd: '/workspace/repo',
    }
    await expect(coordinator.warm(handle)).resolves.toBeUndefined()
    await expect(coordinator.warm(handle)).resolves.toBeUndefined()

    expect(getOrCreate).toHaveBeenCalledTimes(2)
  })

  it('does not let stale completion replace an invalidated generation', async () => {
    let releaseFirst!: () => void
    getOrCreate
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          releaseFirst = resolve
        }),
      )
      .mockResolvedValueOnce(undefined)
    const coordinator = new WorkspaceWarmupCoordinator()

    const handle = {
      environmentId: 'cloud:workspace-1',
      cwd: '/workspace/repo',
    }
    const stale = coordinator.warm(handle, 1)
    const current = coordinator.warm(handle, 2)
    releaseFirst()
    await Promise.all([stale, current])

    await coordinator.warm(handle, 2)
    expect(getOrCreate).toHaveBeenCalledTimes(3)
  })

  it('starts fresh work after an environment is invalidated', async () => {
    let releaseFirst!: () => void
    getOrCreate
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          releaseFirst = resolve
        }),
      )
      .mockResolvedValueOnce(undefined)
    const coordinator = new WorkspaceWarmupCoordinator()
    const handle = {
      environmentId: 'cloud:workspace-1',
      cwd: '/workspace/repo',
    }

    const stale = coordinator.warm(handle)
    coordinator.invalidateEnvironment(handle.environmentId)
    const current = coordinator.warm(handle)
    expect(getOrCreate).toHaveBeenCalledTimes(2)

    releaseFirst()
    await Promise.all([stale, current])
  })
})
