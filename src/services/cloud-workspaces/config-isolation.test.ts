import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetSettingsCache,
  resolveSettings,
} from '../../core/settings-manager.js'
import { loadAgentPickerWorkspace } from '../../core/agent-picker-workspace.js'
import { loadSkillsFromDisk } from '../../skills/loadSkillsDir.js'
import { loadUserAgentRules } from '../../utils/rules-loader.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { resolveWorkspaceContext } from './turn-scope.js'

let tmp: string
let previousAuth: string | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-config-isolation-'))
  previousAuth = process.env.AUTH_ENABLED
  process.env.AUTH_ENABLED = 'true'
  resetSettingsCache()
})

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  resetSettingsCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

describe('cloud configuration isolation', () => {
  it('loads user settings, skills, and rules without reading repository config', async () => {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'container-repo')
    write(
      path.join(home, '.ai-agent/settings.json'),
      JSON.stringify({ disabledTools: ['user-only-tool'] }),
    )
    write(
      path.join(repo, '.ai-agent/settings.json'),
      JSON.stringify({ disabledTools: ['repo-only-tool'] }),
    )
    write(
      path.join(home, '.ai-agent/skills/user-skill/SKILL.md'),
      '---\ndescription: User skill package\n---\nuser body\n',
    )
    write(
      path.join(repo, '.ai-agent/skills/repo-skill/SKILL.md'),
      '---\ndescription: Repository skill package\n---\nrepo body\n',
    )
    write(path.join(home, '.ai-agent/rules/user.md'), 'USER_RULE_SENTINEL')
    write(path.join(repo, 'AGENTS.md'), 'REPO_AGENTS_SENTINEL')
    write(path.join(repo, '.ai-agent/rules/repo.md'), 'REPO_RULE_SENTINEL')

    await runWithRequestScope({ agentHome: home, cwd: home }, async () => {
      const scope = resolveWorkspaceContext(
        {
          environmentId: 'cloud:abcdef0123456789',
          cwd: '/workspace/repo',
        },
        '/workspace/repo',
      )
      const settings = resolveSettings(scope.settingsCwd)
      const loadedSkills = await loadSkillsFromDisk(scope.extensionCwd)
      const rules = loadUserAgentRules()

      expect(settings.config.disabledTools).toContain('user-only-tool')
      expect(settings.config.disabledTools).not.toContain('repo-only-tool')
      expect(loadedSkills.skills.map(skill => skill.name)).toContain(
        'user-skill',
      )
      expect(loadedSkills.skills.map(skill => skill.name)).not.toContain(
        'repo-skill',
      )
      expect(rules).toContain('USER_RULE_SENTINEL')
      expect(rules).not.toContain('REPO_AGENTS_SENTINEL')
      expect(rules).not.toContain('REPO_RULE_SENTINEL')
    })
  })

  it('loads the agent picker from user config instead of the container cwd', async () => {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'container-repo')
    write(
      path.join(home, '.ai-agent/settings.json'),
      JSON.stringify({
        agents: {
          picker: { modes: ['ask'], primaries: [] },
          default: { mode: 'ask', agentType: null },
        },
      }),
    )
    write(
      path.join(repo, '.ai-agent/settings.json'),
      JSON.stringify({
        agents: {
          picker: { modes: ['plan'], primaries: [] },
          default: { mode: 'plan', agentType: null },
        },
      }),
    )

    await runWithRequestScope({ agentHome: home, cwd: home }, async () => {
      const { picker, scope } = await loadAgentPickerWorkspace(
        {
          environmentId: 'cloud:abcdef0123456789',
          cwd: repo,
        },
        repo,
      )

      expect(scope.settingsCwd).toBe(home)
      expect(scope.extensionCwd).toBe(home)
      expect(picker.modes).toEqual(['ask'])
      expect(picker.default).toEqual({ mode: 'ask', agentType: null })
    })
  })
})
