import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  seedWorkspace: vi.fn(),
  loadPlugins: vi.fn(async () => ({
    errors: [],
    skills: [],
    agentFiles: [],
  })),
  loadAgents: vi.fn(async () => ({ activeAgents: [] })),
  loadSkills: vi.fn(async () => ({ skills: [], errors: [] })),
}))

vi.mock('./workspace-seed.js', () => ({
  seedUserWorkspaceIfNeeded: mocks.seedWorkspace,
}))

vi.mock('./plugins/loader.js', () => ({
  loadPlugins: mocks.loadPlugins,
}))

vi.mock('../tools/AgentTool/loadAgents.js', () => ({
  loadAgentDefinitions: mocks.loadAgents,
}))

vi.mock('../skills/loadSkillsDir.js', () => ({
  loadSkillsFromDisk: mocks.loadSkills,
  mergeSkillsByName: (_pluginSkills: unknown[], diskSkills: unknown[]) =>
    diskSkills,
}))

import { loadWorkspaceContributions } from './workspace-load.js'

const previousCloudWorkspaces = process.env.CLOUD_WORKSPACES

describe('loadWorkspaceContributions workspace seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (previousCloudWorkspaces === undefined) {
      delete process.env.CLOUD_WORKSPACES
    } else {
      process.env.CLOUD_WORKSPACES = previousCloudWorkspaces
    }
  })

  it('does not seed a container cwd through the Cloud control plane', async () => {
    process.env.CLOUD_WORKSPACES = 'docker'

    await loadWorkspaceContributions('/workspace/repo')

    expect(mocks.seedWorkspace).not.toHaveBeenCalled()
  })

  it('keeps seeding local Desktop and SSO workspaces', async () => {
    delete process.env.CLOUD_WORKSPACES

    await loadWorkspaceContributions('/host/workspace')

    expect(mocks.seedWorkspace).toHaveBeenCalledWith('/host/workspace')
  })
})
