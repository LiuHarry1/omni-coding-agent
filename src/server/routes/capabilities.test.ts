import * as http from 'http'
import { describe, expect, it } from 'vitest'
import {
  buildAgentSpawnEnv,
  selectDesktopAgentPort,
} from '../../../desktop/agent-launch.mjs'
import {
  createCapabilitiesRouter,
  parseDisabledFeatures,
  resolveEffectiveCapabilities,
  resolveRuntimeProfile,
} from './capabilities.js'

describe('effective capabilities', () => {
  it('describes the desktop runtime by default', () => {
    const manifest = resolveEffectiveCapabilities({})

    expect(manifest).toMatchObject({
      version: 1,
      profile: 'desktop',
      disabledFeatures: [],
      workspace: {
        enabled: true,
        reason: null,
        lifecycle: 'host',
        createMethods: ['local-folder', 'ssh'],
      },
      extensions: {
        scopes: ['user', 'workspace'],
        sections: {
          plugins: { enabled: true, reason: null },
        },
      },
      mcp: {
        enabled: true,
        transports: ['stdio', 'http', 'sse'],
      },
      marketplace: {
        enabled: true,
        targets: ['user', 'workspace'],
      },
    })
  })

  it('derives the constrained cloud runtime from Docker workspaces', () => {
    const manifest = resolveEffectiveCapabilities({
      CLOUD_WORKSPACES: 'docker',
    })

    expect(manifest).toMatchObject({
      profile: 'cloud',
      workspace: {
        enabled: true,
        lifecycle: 'managed',
        createMethods: ['clone', 'blank'],
      },
      extensions: {
        scopes: ['user'],
        sections: {
          plugins: {
            enabled: false,
          },
        },
      },
      mcp: {
        enabled: true,
        transports: ['http', 'sse'],
      },
      marketplace: {
        enabled: true,
        targets: ['user'],
      },
    })
    expect(manifest.extensions.sections.plugins.reason).toMatch(/cloud/i)
  })

  it('validates explicit runtime profiles against the available backend', () => {
    expect(resolveRuntimeProfile({ BAIZE_RUNTIME_PROFILE: 'desktop' })).toBe(
      'desktop',
    )
    expect(
      resolveRuntimeProfile({
        BAIZE_RUNTIME_PROFILE: 'cloud',
        CLOUD_WORKSPACES: 'docker',
      }),
    ).toBe('cloud')
    expect(() =>
      resolveRuntimeProfile({ BAIZE_RUNTIME_PROFILE: 'serverless' }),
    ).toThrow(/BAIZE_RUNTIME_PROFILE/)
    expect(() =>
      resolveRuntimeProfile({ BAIZE_RUNTIME_PROFILE: 'cloud' }),
    ).toThrow(/requires CLOUD_WORKSPACES=docker/)
    expect(() =>
      resolveRuntimeProfile({
        BAIZE_RUNTIME_PROFILE: 'desktop',
        CLOUD_WORKSPACES: 'docker',
      }),
    ).toThrow(/incompatible/)
  })

  it('accepts only allowlisted feature disables and applies them', () => {
    expect(parseDisabledFeatures(' mcp,skills,mcp, marketplace ')).toEqual([
      'mcp',
      'skills',
      'marketplace',
    ])
    expect(() => parseDisabledFeatures('mcp,unknown')).toThrow(
      /Invalid BAIZE_DISABLED_FEATURES.*unknown/,
    )

    const manifest = resolveEffectiveCapabilities({
      BAIZE_DISABLED_FEATURES: 'workspaces,mcp,marketplace,skills',
    })
    expect(manifest.disabledFeatures).toEqual([
      'workspaces',
      'mcp',
      'marketplace',
      'skills',
    ])
    expect(manifest.workspace).toMatchObject({
      enabled: false,
      createMethods: [],
    })
    expect(manifest.extensions.sections.skills.enabled).toBe(false)
    expect(manifest.extensions.sections.mcp.reason).toMatch(
      /BAIZE_DISABLED_FEATURES/,
    )
    expect(manifest.mcp.transports).toEqual([])
    expect(manifest.marketplace.targets).toEqual([])
  })
})

describe('capabilities HTTP route', () => {
  it('serves the versioned manifest without claiming /health', async () => {
    const capabilities = createCapabilitiesRouter({
      CLOUD_WORKSPACES: 'docker',
    })
    const server = http.createServer((req, res) => {
      if (capabilities(req, res)) return
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind a TCP port')
      }
      const baseURL = `http://127.0.0.1:${address.port}`

      const response = await fetch(`${baseURL}/capabilities`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        version: 1,
        profile: 'cloud',
      })

      const health = await fetch(`${baseURL}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ status: 'ok' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('desktop agent environment', () => {
  it('isolates the desktop child from inherited cloud server settings', () => {
    const spawnEnv = (baseEnv: NodeJS.ProcessEnv) =>
      buildAgentSpawnEnv(
        '/missing-app-root',
        4567,
        baseEnv,
      ) as NodeJS.ProcessEnv

    expect(spawnEnv({}).BAIZE_RUNTIME_PROFILE).toBe('desktop')
    const inheritedCloud = spawnEnv({
      AUTH_ENABLED: 'true',
      BAIZE_RUNTIME_PROFILE: 'cloud',
      CLOUD_WORKSPACES: 'docker',
      HOST: '0.0.0.0',
      SERVE_STATIC: '0',
    })
    expect(inheritedCloud).toMatchObject({
      AUTH_ENABLED: 'false',
      BAIZE_RUNTIME_PROFILE: 'desktop',
      CLOUD_WORKSPACES: '',
      HOST: '127.0.0.1',
      SERVE_STATIC: '1',
    })
  })

  it('selects another loopback port when the preferred port is occupied', async () => {
    const blocker = http.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(0, '127.0.0.1', resolve)
      })
      const address = blocker.address()
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind a TCP port')
      }

      const selected = await selectDesktopAgentPort(address.port)
      expect(selected).toBeGreaterThan(0)
      expect(selected).not.toBe(address.port)
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  })
})
