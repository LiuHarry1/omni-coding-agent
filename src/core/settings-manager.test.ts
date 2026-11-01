import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSafeMCPServerMetadata } from './mcp-policy.js'
import {
  getSafeSettings,
  resetSettingsCache,
  resolveEffectiveSettings,
  validateMCPRemoval,
} from './settings-manager.js'
import { runWithRequestScope } from '../utils/request-scope.js'

const previous = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  AI_AGENT_MANAGED_DIR: process.env.AI_AGENT_MANAGED_DIR,
}

let root: string
let home: string
let workspace: string
let managed: string

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

const httpServer = (name: string) => ({
  url: `https://${name}.example.test/mcp?token=${name}-secret`,
  transport: 'http' as const,
  headers: { Authorization: `Bearer ${name}-secret` },
})

describe('MCP settings provenance', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-provenance-'))
    home = path.join(root, 'home')
    workspace = path.join(root, 'workspace')
    managed = path.join(root, 'managed')
    fs.mkdirSync(home)
    fs.mkdirSync(workspace)
    fs.mkdirSync(managed)
    process.env.AUTH_ENABLED = 'true'
    process.env.AI_AGENT_MANAGED_DIR = managed
    resetSettingsCache()
  })

  afterEach(() => {
    resetSettingsCache()
    fs.rmSync(root, { recursive: true, force: true })
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('tracks the winning layer and returns only masked MCP metadata', async () => {
    writeJson(path.join(home, '.ai-agent', 'settings.json'), {
      mcpServers: {
        shared: httpServer('user'),
        userOnly: httpServer('user-only'),
      },
    })
    writeJson(path.join(workspace, '.ai-agent', 'settings.json'), {
      mcpServers: {
        shared: httpServer('project'),
        projectOnly: httpServer('project-only'),
      },
    })
    writeJson(path.join(workspace, '.ai-agent', 'settings.local.json'), {
      mcpServers: {
        shared: httpServer('local'),
        localOnly: httpServer('local-only'),
      },
    })
    writeJson(path.join(managed, 'managed-settings.json'), {
      mcpServers: {
        shared: httpServer('managed'),
        managedOnly: httpServer('managed-only'),
      },
    })
    writeJson(
      path.join(workspace, '.ai-agent', 'plugins', 'example', '.mcp.json'),
      {
        pluginOnly: {
          command: 'npx',
          args: ['--token', 'plugin-secret'],
          env: { API_KEY: 'plugin-secret' },
        },
      },
    )

    const effective = await runWithRequestScope(
      { agentHome: home, cwd: workspace },
      () => resolveEffectiveSettings(workspace),
    )

    expect(effective.mcpProvenance).toMatchObject({
      shared: { configuredBy: 'managed', writable: false },
      userOnly: {
        configuredBy: 'user',
        writable: true,
        writableScope: 'user',
      },
      projectOnly: {
        configuredBy: 'project',
        writable: true,
        writableScope: 'project',
      },
      localOnly: {
        configuredBy: 'local',
        writable: true,
        writableScope: 'local',
      },
      managedOnly: { configuredBy: 'managed', writable: false },
      pluginOnly: { configuredBy: 'plugin', writable: false },
    })

    const safeSettings = getSafeSettings(effective)
    expect(safeSettings).not.toHaveProperty('mcpServers')
    const metadata = getSafeMCPServerMetadata(
      effective.effectiveMcpServers,
      effective.mcpProvenance,
    )
    expect(metadata.shared).toMatchObject({
      transport: 'http',
      configuredBy: 'managed',
      writable: false,
      headerNames: ['Authorization'],
    })
    expect(metadata.pluginOnly).toEqual({
      transport: 'stdio',
      configuredBy: 'plugin',
      writable: false,
    })
    expect(JSON.stringify(metadata)).not.toMatch(
      /managed-secret|plugin-secret|Bearer|npx/,
    )
    expect(
      validateMCPRemoval(effective.mcpProvenance, 'pluginOnly', 'user'),
    ).toMatchObject({ status: 409, error: expect.stringMatching(/read-only/) })
    expect(
      validateMCPRemoval(effective.mcpProvenance, 'projectOnly', 'user'),
    ).toMatchObject({ status: 409, error: expect.stringMatching(/project/) })
    expect(
      validateMCPRemoval(effective.mcpProvenance, 'missing', 'user'),
    ).toEqual({ status: 404, error: 'MCP server not found' })
    expect(
      validateMCPRemoval(effective.mcpProvenance, 'projectOnly', 'project'),
    ).toBeNull()
  })
})
