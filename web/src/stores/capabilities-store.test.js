import { describe, expect, it, vi } from 'vitest'
import {
  SAFE_DESKTOP_CAPABILITIES,
  validateCapabilitiesManifest,
} from './capabilities-model.js'
import { createCapabilitiesStore } from './capabilities-store.js'

function cloudManifest() {
  const manifest = structuredClone(SAFE_DESKTOP_CAPABILITIES)
  manifest.profile = 'cloud'
  manifest.workspace.lifecycle = 'managed'
  manifest.workspace.createMethods = ['clone', 'blank']
  manifest.extensions.scopes = ['user']
  manifest.mcp.transports = ['http', 'sse']
  manifest.marketplace.targets = ['user']
  return manifest
}

function httpError(status, message = `HTTP ${status}`) {
  const error = new Error(message)
  error.status = status
  return error
}

describe('capabilities model', () => {
  it('provides safe legacy desktop defaults', () => {
    expect(SAFE_DESKTOP_CAPABILITIES).toMatchObject({
      version: 1,
      profile: 'desktop',
      workspace: {
        lifecycle: 'host',
        createMethods: ['local-folder', 'ssh'],
      },
      extensions: {
        scopes: ['user', 'workspace'],
      },
      mcp: {
        transports: ['stdio', 'http', 'sse'],
      },
      marketplace: {
        targets: ['user', 'workspace'],
      },
    })
  })

  it('rejects unsupported or incomplete manifests', () => {
    expect(() =>
      validateCapabilitiesManifest({
        ...structuredClone(SAFE_DESKTOP_CAPABILITIES),
        version: 2,
      }),
    ).toThrow(/Unsupported capabilities manifest version/)

    const incomplete = structuredClone(SAFE_DESKTOP_CAPABILITIES)
    delete incomplete.extensions.sections.mcp
    expect(() => validateCapabilitiesManifest(incomplete)).toThrow(
      /extensions\.sections\.mcp/,
    )
  })
})

describe('capabilities store', () => {
  it('coalesces concurrent loads and keeps the server manifest', async () => {
    let resolveRequest
    const request = new Promise(resolve => {
      resolveRequest = resolve
    })
    const api = { get: vi.fn(() => request) }
    const store = createCapabilitiesStore(api)

    const first = store.getState().load()
    const second = store.getState().load()
    expect(second).toBe(first)

    const manifest = cloudManifest()
    resolveRequest(manifest)
    await expect(first).resolves.toBe(manifest)
    await store.getState().load()

    expect(api.get).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({
      status: 'ready',
      loaded: true,
      error: null,
      profile: 'cloud',
      manifest,
    })
  })

  it('uses desktop defaults only for a legacy 404 endpoint', async () => {
    const api = {
      get: vi.fn().mockRejectedValue(httpError(404, 'HTTP 404: Not found')),
    }
    const store = createCapabilitiesStore(api)

    await expect(store.getState().load()).resolves.toBe(
      SAFE_DESKTOP_CAPABILITIES,
    )
    await store.getState().load()

    expect(api.get).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({
      status: 'legacy',
      loaded: true,
      error: 'HTTP 404: Not found',
      profile: 'desktop',
      manifest: SAFE_DESKTOP_CAPABILITIES,
    })
  })

  it('retries a transient failure before committing the server profile', async () => {
    const manifest = cloudManifest()
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValueOnce(manifest),
    }
    const sleepFn = vi.fn(async () => {})
    const store = createCapabilitiesStore(api, {
      retryDelays: [10],
      sleepFn,
    })

    await expect(store.getState().load()).resolves.toBe(manifest)

    expect(api.get).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(10)
    expect(store.getState()).toMatchObject({
      status: 'ready',
      loaded: true,
      profile: 'cloud',
      error: null,
    })
  })

  it('fails closed after retry exhaustion and supports manual reload', async () => {
    const manifest = cloudManifest()
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(httpError(503))
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValueOnce(manifest),
    }
    const store = createCapabilitiesStore(api, {
      retryDelays: [0],
      sleepFn: async () => {},
    })

    await expect(store.getState().load()).resolves.toBeNull()
    expect(store.getState()).toMatchObject({
      status: 'unavailable',
      loaded: false,
      error: 'HTTP 503',
    })

    await expect(store.getState().reload()).resolves.toBe(manifest)
    expect(api.get).toHaveBeenCalledTimes(3)
    expect(store.getState()).toMatchObject({
      status: 'ready',
      loaded: true,
      profile: 'cloud',
    })
  })

  it('does not retry an invalid capabilities contract', async () => {
    const api = { get: vi.fn().mockResolvedValue({ version: 99 }) }
    const store = createCapabilitiesStore(api, {
      retryDelays: [0, 0],
      sleepFn: async () => {},
    })

    await expect(store.getState().load()).resolves.toBeNull()

    expect(api.get).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({
      status: 'unavailable',
      loaded: false,
    })
  })
})
