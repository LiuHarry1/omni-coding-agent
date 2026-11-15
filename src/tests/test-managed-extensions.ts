/**
 * Managed skills / agents / commands / rules (policy dirs).
 *   conda activate llm_ft && npx tsx src/tests/test-managed-extensions.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadMarkdownConfigs } from '../utils/markdownConfigLoader.js'
import { loadSkillsFromDisk } from '../skills/loadSkillsDir.js'
import { loadAgentDefinitions } from '../tools/AgentTool/loadAgents.js'
import { loadAllAgentRules, loadManagedRules } from '../utils/rules-loader.js'
import {
  _resetManagedDirCacheForTest,
  getManagedAgentsMdPath,
  getManagedSubdir,
} from '../utils/managed-path.js'
import { getAppDirName } from '../utils/app-dir.js'
import { resetSettingsCache } from '../utils/settings/manager.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-ext-'))
const managedDir = path.join(tmp, 'etc-ai-agent')
const cwd = path.join(tmp, 'project')
const projectAgentDir = path.join(cwd, getAppDirName(), 'agents')
const projectSkillDir = path.join(cwd, getAppDirName(), 'skills', 'shared')

fs.mkdirSync(path.join(managedDir, getAppDirName(), 'skills', 'shared'), {
  recursive: true,
})
fs.mkdirSync(path.join(managedDir, getAppDirName(), 'agents'), {
  recursive: true,
})
fs.mkdirSync(path.join(managedDir, getAppDirName(), 'commands'), {
  recursive: true,
})
fs.mkdirSync(path.join(managedDir, getAppDirName(), 'rules'), {
  recursive: true,
})
fs.mkdirSync(projectAgentDir, { recursive: true })
fs.mkdirSync(projectSkillDir, { recursive: true })

process.env.AI_AGENT_MANAGED_DIR = managedDir
delete process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS
_resetManagedDirCacheForTest()
resetSettingsCache()

try {
  fs.writeFileSync(
    getManagedAgentsMdPath(),
    '# Managed policy\nAlways follow managed rules.\n',
  )
  fs.writeFileSync(
    path.join(getManagedSubdir('rules'), 'security.md'),
    'No secrets in logs.\n',
  )

  fs.writeFileSync(
    path.join(getManagedSubdir('skills'), 'shared', 'SKILL.md'),
    `---
description: Managed shared skill
---
Managed body.
`,
  )
  fs.writeFileSync(
    path.join(projectSkillDir, 'SKILL.md'),
    `---
description: Project shared skill
---
Project body.
`,
  )

  fs.writeFileSync(
    path.join(getManagedSubdir('agents'), 'reviewer.md'),
    `---
name: reviewer
description: Managed reviewer
---
You are the managed reviewer.
`,
  )
  fs.writeFileSync(
    path.join(projectAgentDir, 'reviewer.md'),
    `---
name: reviewer
description: Project reviewer
---
You are the project reviewer.
`,
  )

  fs.writeFileSync(
    path.join(getManagedSubdir('commands'), 'ping.md'),
    `---
description: Managed ping
---
pong from managed
`,
  )

  const { skills } = await loadSkillsFromDisk(cwd)
  const shared = skills.find(s => s.name === 'shared')
  assert(shared, 'shared skill missing')
  assert(shared.source === 'managed', `expected managed, got ${shared.source}`)
  assert(
    shared.description.includes('Managed'),
    'managed skill description should win',
  )
  console.log('ok: managed skill overrides project')

  process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1'
  const { skills: noPolicy } = await loadSkillsFromDisk(cwd)
  const shared2 = noPolicy.find(s => s.name === 'shared')
  assert(shared2?.source === 'project', 'disable policy skills → project wins')
  delete process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS
  console.log('ok: CLAUDE_CODE_DISABLE_POLICY_SKILLS')

  const agents = await loadAgentDefinitions(cwd)
  const reviewer = agents.activeAgents.find(a => a.agentType === 'reviewer')
  assert(reviewer, 'reviewer agent missing')
  assert(
    reviewer.source === 'managed',
    `expected managed agent, got ${reviewer.source}`,
  )
  assert(
    reviewer.systemPrompt.includes('managed reviewer'),
    'managed agent body should win',
  )
  console.log('ok: managed agent overrides project')

  const cmds = await loadMarkdownConfigs('commands', cwd)
  assert(
    cmds.some(c => c.source === 'managed' && c.filePath.endsWith('ping.md')),
    'managed command not loaded',
  )
  console.log('ok: managed command loaded')

  const managedRules = loadManagedRules()
  assert(managedRules.includes('Managed policy'), 'AGENTS.md missing')
  assert(managedRules.includes('No secrets'), 'rules/*.md missing')
  const all = loadAllAgentRules(cwd)
  assert(all.includes('Managed policy'), 'loadAllAgentRules missing managed')
  console.log('ok: managed rules + AGENTS.md')

  console.log('\nAll managed-extension checks passed.')
} finally {
  delete process.env.AI_AGENT_MANAGED_DIR
  delete process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS
  _resetManagedDirCacheForTest()
  resetSettingsCache()
  fs.rmSync(tmp, { recursive: true, force: true })
}
