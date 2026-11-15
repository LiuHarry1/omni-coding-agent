import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSafeMCPServerMetadata } from '../../services/mcp/policy.js'
import {
  getSafeSettings,
  resetSettingsCache,
  resolveEffectiveSettings,
  resolveSettings,
  validateMCPRemoval,
} from './manager.js'
import { runWithRequestScope } from '../workspace/request-scope.js'

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

describe('hooks settings', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-settings-'))
    home = path.join(root, 'home')
    workspace = path.join(root, 'workspace')
    managed = path.join(root, 'managed')
    fs.mkdirSync(home)
    fs.mkdirSync(workspace)
    fs.mkdirSync(managed)
    // With sign-in on, the user settings come from `home` rather than from
    // the home directory of whoever runs the tests.
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

  const resolveHooks = () =>
    runWithRequestScope({ agentHome: home, cwd: workspace }, () =>
      resolveSettings(workspace),
    ).config.hooks

  it('combines the hooks of every settings file', () => {
    writeJson(path.join(home, '.ai-agent', 'settings.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-done' }] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'guard', timeout: 5 }],
          },
        ],
      },
    })
    writeJson(path.join(workspace, '.ai-agent', 'settings.json'), {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'check-paths' }],
          },
        ],
      },
    })

    expect(resolveHooks()).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'notify-done' }] }],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'guard', timeout: 5 }],
        },
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: 'check-paths' }],
        },
      ],
    })
  })

  it('skips events and hook types it does not run, keeping the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeJson(path.join(workspace, '.ai-agent', 'settings.json'), {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'load-context' }] },
          ],
          PostToolUse: [
            {
              matcher: 'Edit',
              hooks: [
                { type: 'prompt', prompt: 'Was this edit safe?' },
                { type: 'command', command: 'format' },
              ],
            },
            { hooks: [{ type: 'prompt', prompt: 'Only a prompt hook' }] },
          ],
        },
      })

      expect(resolveHooks()).toEqual({
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'format' }] },
        ],
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves hooks unset when no file configures any', () => {
    writeJson(path.join(workspace, '.ai-agent', 'settings.json'), {})

    expect(resolveHooks()).toBeUndefined()
  })
})
