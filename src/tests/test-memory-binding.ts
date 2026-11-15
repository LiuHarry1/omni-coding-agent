/**
 * MemoryBinding — one resolve, four consumers stay aligned.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AgentDefinition, AutoMemoryConfig } from '../core/types.js'
import { parseMemoryPolicy } from '../tools/AgentTool/memoryPolicy.js'
import { parseAgentFromMarkdown } from '../tools/AgentTool/mergeAgents.js'
import { getAgentMemoryDir } from '../tools/AgentTool/agentMemory.js'
import {
  buildMemorySystemAppend,
  resolveMemoryBinding,
} from '../services/auto-memory/index.js'
import { getAutoMemPath } from '../services/auto-memory/paths.js'
import { setCwd } from '../utils/workspace/cwd.js'
import { runWithRequestScope } from '../utils/workspace/request-scope.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const CFG: AutoMemoryConfig = {
  enabled: true,
  extractEveryNTurns: 1,
  cacheSafe: true,
  prefetchEnabled: true,
  prefetchModelTier: 'small',
}

function stubAgent(
  partial: Partial<AgentDefinition> & Pick<AgentDefinition, 'agentType'>,
): AgentDefinition {
  return {
    whenToUse: 'test',
    description: 'test',
    systemPrompt: 'test',
    ...partial,
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bind-'))
const home = path.join(tmpRoot, 'home')
const cwd = path.join(tmpRoot, 'proj')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(cwd, { recursive: true })

const prevAuth = process.env.AUTH_ENABLED
process.env.AUTH_ENABLED = 'true'

try {
  await runWithRequestScope({ agentHome: home, cwd }, async () => {
    setCwd(cwd)

    // ── parse: short form + object form ──
    const short = parseMemoryPolicy('project')
    assert(short.policy?.mode === 'private', 'short form is private')
    assert(short.scope === 'project', 'short form scope')
    assert(short.policy?.vocabulary === 'coding', 'short form vocab')

    const obj = parseMemoryPolicy({
      mode: 'private',
      scope: 'local',
      vocabulary: 'external',
    })
    assert(obj.policy?.mode === 'private', 'object private')
    assert(obj.scope === 'local', 'object scope')
    assert(obj.policy?.vocabulary === 'external', 'object vocab')

    const shared = parseMemoryPolicy({ mode: 'shared' })
    assert(shared.policy?.mode === 'shared', 'object shared')
    assert(shared.scope === undefined, 'shared has no short-form scope')

    const bad = parseMemoryPolicy('nope')
    assert(!bad.policy && bad.warnings.length > 0, 'invalid short form warns')

    const primary = parseAgentFromMarkdown({
      filePath: path.join(cwd, 'agents', 'browser.md'),
      baseDir: path.join(cwd, 'agents'),
      source: 'project',
      frontmatter: {
        name: 'browser',
        description: 'Drive a browser',
        mode: 'primary',
        memory: { mode: 'private', scope: 'local', vocabulary: 'external' },
      },
      body: 'You drive a browser.',
    })
    assert(primary.agent?.memory === 'local', 'primary object sets scope')
    assert(
      primary.agent?.memoryPolicy?.mode === 'private',
      'primary object policy',
    )
    assert(
      primary.agent?.memoryPolicy?.vocabulary === 'external',
      'primary object vocab',
    )

    const shortPrimary = parseAgentFromMarkdown({
      filePath: path.join(cwd, 'agents', 'coder.md'),
      baseDir: path.join(cwd, 'agents'),
      source: 'project',
      frontmatter: {
        name: 'coder-primary',
        description: 'Code',
        mode: 'primary',
        memory: 'project',
      },
      body: 'You write code.',
    })
    assert(
      shortPrimary.agent?.memory === 'project',
      'primary short form is no longer ignored',
    )
    assert(
      shortPrimary.agent?.memoryPolicy?.mode === 'private',
      'primary short form policy',
    )

    const reviewer = stubAgent({
      agentType: 'code-reviewer',
      mode: 'subagent',
      memory: 'project',
      memoryPolicy: {
        mode: 'private',
        scope: 'project',
        vocabulary: 'coding',
      },
    })

    // ── disabled ──
    const off = resolveMemoryBinding({
      cwd,
      config: { ...CFG, enabled: false },
      profile: null,
      remote: false,
    })
    assert(off.source === 'disabled', 'disabled source')
    assert(off.readDirs.length === 0 && !off.writeDir, 'disabled dirs')
    assert(buildMemorySystemAppend(off) === '', 'disabled prompt empty')

    const remote = resolveMemoryBinding({
      cwd,
      config: CFG,
      profile: null,
      remote: true,
    })
    assert(remote.source === 'disabled', 'remote disables binding')

    // ── shared default ──
    const sharedBind = resolveMemoryBinding({
      cwd,
      config: CFG,
      profile: null,
      remote: false,
    })
    const autoDir = getAutoMemPath({ cwd })
    assert(sharedBind.source === 'shared', 'shared source')
    assert(sharedBind.writeDir === autoDir, 'shared write')
    assert(sharedBind.readDirs[0] === autoDir, 'shared read')
    assert(sharedBind.roots.write[0] === autoDir, 'shared write root')
    assert(sharedBind.prompt.kind === 'auto', 'shared prompt kind')
    assert(sharedBind.prompt.placement === 'project-rules', 'shared placement')
    const sharedGuide = buildMemorySystemAppend(sharedBind)
    assert(sharedGuide.includes(autoDir), 'shared prompt names write dir')
    assert(
      sharedBind.prompt.dir === sharedBind.writeDir &&
        sharedBind.writeDir === sharedBind.roots.write[0] &&
        sharedBind.readDirs[0] === sharedBind.writeDir,
      'shared invariant: prompt == prefetch == extract == write root',
    )

    // ── private primary ──
    const browser = stubAgent({
      agentType: 'browser',
      mode: 'primary',
      memory: 'local',
      memoryPolicy: {
        mode: 'private',
        scope: 'local',
        vocabulary: 'external',
      },
    })
    const privateBind = resolveMemoryBinding({
      cwd,
      config: CFG,
      profile: browser,
      remote: false,
    })
    const localDir = getAgentMemoryDir('browser', 'local', cwd)
    assert(privateBind.source === 'agent:browser', 'private source')
    assert(privateBind.writeDir === localDir, 'private write')
    assert(privateBind.readDirs[0] === localDir, 'private read')
    assert(privateBind.prompt.kind === 'agent', 'private prompt kind')
    assert(privateBind.prompt.placement === 'standalone', 'private placement')
    assert(privateBind.prompt.vocabulary === 'external', 'private vocab')
    const privateGuide = buildMemorySystemAppend(privateBind)
    assert(
      privateGuide.includes('Persistent Agent Memory'),
      'private uses agent prompt',
    )
    assert(privateGuide.includes(localDir), 'private prompt names write dir')
    assert(
      privateGuide.includes('external system'),
      'external vocabulary in prompt',
    )
    assert(
      !privateGuide.includes(autoDir),
      'private prompt does not name shared',
    )
    assert(
      privateBind.prompt.dir === privateBind.writeDir &&
        privateBind.writeDir === privateBind.roots.write[0] &&
        privateBind.readDirs[0] === privateBind.writeDir,
      'private invariant: prompt == prefetch == extract == write root',
    )

    // ── @agent mention overrides read only ──
    const mentioned = resolveMemoryBinding({
      cwd,
      config: CFG,
      profile: null,
      agents: [reviewer],
      queryText: '@agent-code-reviewer please',
      remote: false,
    })
    const reviewerDir = getAgentMemoryDir('code-reviewer', 'project', cwd)
    assert(mentioned.readDirs[0] === reviewerDir, 'mention switches read')
    assert(mentioned.writeDir === autoDir, 'mention keeps shared write')
    assert(mentioned.prompt.dir === autoDir, 'mention does not move prompt dir')
    assert(mentioned.extract.enabled === true, 'mention extract still on')
    assert(
      mentioned.roots.write[0] === autoDir,
      'mention write root stays shared',
    )
    assert(
      mentioned.roots.read.includes(reviewerDir),
      'mention read root includes agent memdir',
    )

    console.log('ok: test-memory-binding')
  })
} finally {
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
