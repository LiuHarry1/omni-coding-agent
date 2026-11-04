import { describe, expect, it, vi } from 'vitest'

import { RuntimeBroker } from './runtime-broker.js'
import type { RuntimePort } from './types.js'

function runtime(): RuntimePort {
  return {
    workspace: {
      environmentId: 'cloud:abcdef0123456789',
      cwd: '/workspace/repo',
    },
    health: vi.fn(async () => 'ok'),
    close: vi.fn(async () => {}),
    onMessage: vi.fn(() => () => {}),
  } as unknown as RuntimePort
}

describe('RuntimeBroker environment cleanup', () => {
  it('keeps runtimes with the same cwd isolated by environment', () => {
    const broker = new RuntimeBroker({} as never, {} as never)
    const first = runtime()
    const second = runtime()
    const internals = broker as unknown as {
      runtimes: Map<string, RuntimePort>
    }
    const firstHandle = {
      environmentId: 'cloud:abcdef0123456789',
      cwd: '/workspace/repo',
    }
    const secondHandle = {
      environmentId: 'cloud:fedcba9876543210',
      cwd: '/workspace/repo',
    }
    internals.runtimes.set(
      `${firstHandle.environmentId}::${firstHandle.cwd}`,
      first,
    )
    internals.runtimes.set(
      `${secondHandle.environmentId}::${secondHandle.cwd}`,
      second,
    )

    expect(broker.get(firstHandle)).toBe(first)
    expect(broker.get(secondHandle)).toBe(second)
  })

  it('closes cached runtimes and ones that finish opening during deletion', async () => {
    const broker = new RuntimeBroker({} as never, {} as never)
    const cached = runtime()
    const opening = runtime()
    const internals = broker as unknown as {
      runtimes: Map<string, RuntimePort>
      opening: Map<string, Promise<RuntimePort>>
    }
    internals.runtimes.set('cloud:abcdef0123456789::/workspace/repo', cached)
    internals.opening.set(
      'cloud:abcdef0123456789::/workspace/other',
      Promise.resolve().then(() => {
        internals.runtimes.set(
          'cloud:abcdef0123456789::/workspace/other',
          opening,
        )
        return opening
      }),
    )

    await broker.closeEnvironment('cloud:abcdef0123456789')

    expect(cached.close).toHaveBeenCalledOnce()
    expect(opening.close).toHaveBeenCalledOnce()
    expect(internals.runtimes.size).toBe(0)
  })

  it('discards a runtime whose open started before the environment closed', async () => {
    const opened = runtime()
    let releaseOpen!: () => void
    const conn = {
      ensureWorker: vi.fn(async () => {}),
      openRuntime: vi.fn(
        () =>
          new Promise<RuntimePort>(resolve => {
            releaseOpen = () => resolve(opened)
          }),
      ),
    }
    const broker = new RuntimeBroker(
      { getConnectionForEnv: () => conn } as never,
      { issueRuntimeAuth: () => ({}) } as never,
    )
    const handle = {
      environmentId: 'cloud:abcdef0123456789',
      cwd: '/workspace/repo',
    }

    const pending = broker.getOrCreate(handle, 'prewarm')
    await vi.waitFor(() => expect(conn.openRuntime).toHaveBeenCalled())
    const closing = broker.closeEnvironment(handle.environmentId)
    releaseOpen()

    await expect(pending).rejects.toThrow(
      /closed while its runtime was opening/,
    )
    await closing
    expect(opened.close).toHaveBeenCalledOnce()
    expect(broker.get(handle)).toBeUndefined()
  })
})
