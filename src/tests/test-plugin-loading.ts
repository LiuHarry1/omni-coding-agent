/**
 * Full plugin loading test: agents, commands, skills, MCP (+ hot reload).
 *
 * Mirrors prepare_chat_turn.ts integration:
 *   loadPlugins → registerSubagents / registerSkills / mergeMCPServers / slash registry
 *
 * Run: npx tsx src/tests/test-plugin-loading.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { loadPlugins } from '../core/plugins/loader.js'
import { loadPluginsOverview } from '../commands/slashRegistry.js'
import { loadSlashRegistry } from '../commands/slashRegistry.js'
import { registerSubagents } from '../tools/AgentTool/index.js'
import { registerSkills } from '../skills/index.js'
import { mergeMCPServers } from '../core/settings-manager.js'
import { defaultRegistry } from '../tools.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** Build a plugin with all conventional component dirs + .mcp.json */
function scaffoldFullPlugin(
  pluginsRoot: string,
  pluginName: string,
  opts?: { nestedAgent?: boolean; manifestMcp?: boolean },
): string {
  const root = path.join(pluginsRoot, pluginName)
  const agentsDir = path.join(root, 'agents')
  const commandsDir = path.join(root, 'commands')
  const skillsDir = path.join(root, 'skills', 'demo-changelog')

  writeFile(
    path.join(root, '.ai-agent-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: pluginName,
        version: '0.1.0',
        description: `Test plugin ${pluginName}`,
        author: { name: 'test' },
        ...(opts?.manifestMcp
          ? {
              mcpServers: {
                'inline-mcp': {
                  command: 'node',
                  args: ['${PLUGIN_ROOT}/scripts/inline-mcp.js'],
                },
              },
            }
          : {}),
      },
      null,
      2,
    ) + '\n',
  )

  const agentPath = opts?.nestedAgent
    ? path.join(agentsDir, 'nested', 'plugin-reviewer.md')
    : path.join(agentsDir, 'plugin-reviewer.md')
  writeFile(
    agentPath,
    `---
name: plugin-reviewer
description: Review code from plugin agent.
---
You are a plugin reviewer. Assets at \${PLUGIN_ROOT}/assets.
`,
  )

  writeFile(
    path.join(commandsDir, 'plugin-hello.md'),
    `---
description: Greet from plugin command.
argument-hint: "[name]"
arguments: "name"
---
Say hello to $name from plugin at \${PLUGIN_ROOT}.
`,
  )

  writeFile(
    path.join(skillsDir, 'SKILL.md'),
    `---
description: Draft changelog from plugin skill.
context: inline
arguments: "summary"
---
Write changelog for: $summary. Templates at \${PLUGIN_ROOT}/templates.
`,
  )

  if (!opts?.manifestMcp) {
    writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'plugin-filesystem': {
              command: 'npx',
              args: [
                '-y',
                '@modelcontextprotocol/server-filesystem',
                '${PLUGIN_ROOT}/sandbox',
              ],
            },
          },
        },
        null,
        2,
      ) + '\n',
    )
    fs.mkdirSync(path.join(root, 'sandbox'), { recursive: true })
  }

  writeFile(path.join(root, 'scripts', 'inline-mcp.js'), '// stub\n')
  return root
}

async function simulateChatTurn(
  cwd: string,
  settingsMcp: Record<string, unknown> = {},
) {
  const plugins = await loadPlugins(cwd)
  const { activeAgents } = await registerSubagents(
    defaultRegistry,
    cwd,
    plugins.agentFiles,
  )
  const { activeSkills } = await registerSkills(
    defaultRegistry,
    cwd,
    activeAgents,
    {
      pluginSkills: plugins.skills,
    },
  )
  const slash = await loadSlashRegistry(cwd)
  const mcpServers = mergeMCPServers(
    plugins.mcpServers,
    settingsMcp as Parameters<typeof mergeMCPServers>[1],
  )
  return { plugins, activeAgents, activeSkills, slash, mcpServers }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function testFullPluginLoad(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-load-'))
  const pluginRoot = scaffoldFullPlugin(
    path.join(tmp, '.ai-agent', 'plugins'),
    'full-plugin',
    { nestedAgent: true },
  )
  console.log(`\n=== full plugin load: ${tmp} ===`)

  const turn = await simulateChatTurn(tmp)

  // Plugin discovery
  assert(
    turn.plugins.plugins.some(p => p.name === 'full-plugin'),
    'full-plugin not discovered',
  )
  const plugin = turn.plugins.plugins.find(p => p.name === 'full-plugin')!
  assert(
    plugin.scope === 'project',
    `expected project scope, got ${plugin.scope}`,
  )
  console.log(`[ok] plugin discovered: ${plugin.name} (${plugin.scope})`)

  // Agents
  assert(turn.plugins.agentFiles.length >= 1, 'no plugin agent files')
  const agentFile = turn.plugins.agentFiles.find(f =>
    f.filePath.includes('plugin-reviewer'),
  )
  assert(!!agentFile, 'plugin-reviewer.md not in agentFiles')
  assert(agentFile!.source === 'plugin', 'agent source should be plugin')
  assert(
    agentFile!.body.includes(pluginRoot) &&
      !agentFile!.body.includes('${PLUGIN_ROOT}'),
    'agent body should substitute PLUGIN_ROOT',
  )
  assert(
    turn.activeAgents.some(
      a => a.agentType === 'plugin-reviewer' && a.source === 'plugin',
    ),
    'plugin-reviewer not in active agents',
  )
  console.log(
    '[ok] agents: nested plugin-reviewer loaded + PLUGIN_ROOT substituted',
  )

  // Commands
  assert(turn.plugins.commandFiles.length >= 1, 'no plugin command files')
  const cmdFile = turn.plugins.commandFiles.find(f =>
    f.filePath.includes('plugin-hello'),
  )
  assert(!!cmdFile, 'plugin-hello.md not in commandFiles')
  assert(
    cmdFile!.body.includes(pluginRoot) &&
      !cmdFile!.body.includes('${PLUGIN_ROOT}'),
    'command body should substitute PLUGIN_ROOT',
  )
  const slashCmd = turn.slash.entries.find(e => e.name === 'plugin-hello')
  assert(slashCmd?.kind === 'command', 'plugin-hello not in slash registry')
  console.log('[ok] commands: plugin-hello in slash registry')

  // Skills
  assert(turn.plugins.skills.length >= 1, 'no plugin skills')
  const skill = turn.plugins.skills.find(s => s.name === 'demo-changelog')
  assert(!!skill, 'demo-changelog skill not loaded')
  assert(skill!.source === 'plugin', 'skill source should be plugin')
  const skillBody = await skill!.loadBody()
  assert(
    skillBody.includes(pluginRoot) && !skillBody.includes('${PLUGIN_ROOT}'),
    'skill body should substitute PLUGIN_ROOT lazily',
  )
  assert(
    turn.activeSkills.some(s => s.name === 'demo-changelog'),
    'demo-changelog not in active skills',
  )
  const slashSkill = turn.slash.entries.find(e => e.name === 'demo-changelog')
  assert(slashSkill?.kind === 'skill', 'demo-changelog not in slash registry')
  console.log('[ok] skills: demo-changelog loaded + PLUGIN_ROOT substituted')

  // MCP (.mcp.json)
  assert(
    'plugin-filesystem' in turn.mcpServers,
    'plugin-filesystem MCP server missing',
  )
  const mcp = turn.mcpServers['plugin-filesystem']!
  assert('command' in mcp, 'expected stdio MCP config')
  const args = (mcp as { args?: string[] }).args ?? []
  assert(
    args.some(a => a.includes(pluginRoot)) &&
      !args.some(a => a.includes('${PLUGIN_ROOT}')),
    'MCP args should substitute PLUGIN_ROOT',
  )
  console.log('[ok] MCP: .mcp.json loaded with PLUGIN_ROOT in args')

  // Overview API shape (used by /plugins + UI)
  const overview = await loadPluginsOverview(tmp)
  const summary = overview.plugins.find(p => p.name === 'full-plugin')
  assert(!!summary, 'full-plugin missing from overview')
  assert(summary!.agents >= 1, 'overview agent count')
  assert(summary!.commands >= 1, 'overview command count')
  assert(summary!.skills >= 1, 'overview skill count')
  assert(summary!.mcp >= 1, 'overview mcp source count')
  console.log(
    `[ok] overview: agents=${summary!.agents} commands=${summary!.commands} ` +
      `skills=${summary!.skills} mcp=${summary!.mcp}`,
  )
}

async function testManifestInlineMcp(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-inline-'))
  const pluginRoot = scaffoldFullPlugin(
    path.join(tmp, '.ai-agent', 'plugins'),
    'inline-mcp-plugin',
    { manifestMcp: true },
  )
  console.log(`\n=== manifest inline MCP: ${tmp} ===`)

  const { mcpServers } = await simulateChatTurn(tmp)
  assert('inline-mcp' in mcpServers, 'inline-mcp from manifest missing')
  const cfg = mcpServers['inline-mcp']!
  assert('command' in cfg, 'inline MCP should be stdio')
  const args = (cfg as { args?: string[] }).args ?? []
  assert(
    args.some(a => a.includes(pluginRoot)),
    'inline MCP args should substitute PLUGIN_ROOT',
  )
  console.log('[ok] manifest inline mcpServers loaded')
}

async function testMcpCollision(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-collision-'))
  const pluginsDir = path.join(tmp, '.ai-agent', 'plugins')

  for (const name of ['plugin-a', 'plugin-b']) {
    const root = path.join(pluginsDir, name)
    fs.mkdirSync(root, { recursive: true })
    writeFile(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { command: 'echo', args: [name] },
        },
      }) + '\n',
    )
  }

  console.log(`\n=== MCP collision: ${tmp} ===`)
  const result = await loadPlugins(tmp)
  const projectPlugins = result.plugins.filter(
    plugin =>
      plugin.scope === 'project' &&
      (plugin.name === 'plugin-a' || plugin.name === 'plugin-b'),
  )
  assert(projectPlugins.length === 2, 'expected 2 project plugins')
  assert('shared' in result.mcpServers, 'shared MCP should exist')
  assert(
    result.errors.some(e => e.type === 'mcp-collision'),
    'expected mcp-collision error',
  )
  console.log(
    '[ok] MCP name collision recorded; later plugin wins flat namespace',
  )
}

async function testHotReloadPlugin(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hot-'))
  const pluginsDir = path.join(tmp, '.ai-agent', 'plugins')
  console.log(`\n=== plugin hot reload: ${tmp} ===`)

  let turn = await simulateChatTurn(tmp)
  assert(
    !turn.plugins.plugins.some(p => p.name === 'hot-plugin'),
    'turn1 should not have hot-plugin',
  )
  console.log('Turn 1 (no project hot-plugin): ok')

  const hotRoot = scaffoldFullPlugin(pluginsDir, 'hot-plugin')
  turn = await simulateChatTurn(tmp)
  assert(
    turn.plugins.plugins.some(p => p.name === 'hot-plugin'),
    'hot-plugin missing turn2',
  )
  assert(
    turn.plugins.agentFiles.some(file => file.filePath.startsWith(hotRoot)),
    'agent missing turn2',
  )
  assert(
    turn.plugins.commandFiles.some(file => file.filePath.startsWith(hotRoot)),
    'command missing turn2',
  )
  assert(
    turn.plugins.skills.some(skill => skill.baseDir?.startsWith(hotRoot)),
    'skill missing turn2',
  )
  const hotMcp = turn.mcpServers['plugin-filesystem'] as
    { args?: string[] } | undefined
  assert(
    hotMcp?.args?.some(arg => arg.includes(hotRoot)) === true,
    'mcp missing turn2',
  )
  console.log(
    'Turn 2 (+full plugin): agents, commands, skills, MCP all present',
  )

  fs.rmSync(path.join(pluginsDir, 'hot-plugin'), {
    recursive: true,
    force: true,
  })
  turn = await simulateChatTurn(tmp)
  assert(
    !turn.plugins.plugins.some(p => p.name === 'hot-plugin'),
    'plugin should be gone',
  )
  assert(
    !turn.plugins.agentFiles.some(file => file.filePath.startsWith(hotRoot)),
    'agent should be gone',
  )
  assert(
    !turn.plugins.commandFiles.some(file => file.filePath.startsWith(hotRoot)),
    'command should be gone',
  )
  assert(
    !turn.plugins.skills.some(skill => skill.baseDir?.startsWith(hotRoot)),
    'skill should be gone',
  )
  const remainingMcp = turn.mcpServers['plugin-filesystem'] as
    { args?: string[] } | undefined
  assert(
    !remainingMcp?.args?.some(arg => arg.includes(hotRoot)),
    'mcp should be gone',
  )
  console.log('Turn 3 (-removed plugin): all contributions cleared')
  console.log('[ok] plugin hot reload')
}

async function testSettingsMcpOverridesPlugin(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-override-'))
  scaffoldFullPlugin(path.join(tmp, '.ai-agent', 'plugins'), 'override-plugin')
  console.log(`\n=== settings MCP overrides plugin: ${tmp} ===`)

  const settingsMcp = {
    'plugin-filesystem': { command: 'echo', args: ['from-settings'] },
  }
  const { mcpServers } = await simulateChatTurn(tmp, settingsMcp)
  const cfg = mcpServers['plugin-filesystem'] as { args?: string[] }
  assert(
    cfg?.args?.[0] === 'from-settings',
    'settings MCP should win on collision',
  )
  console.log('[ok] mergeMCPServers: settings override plugin')
}

async function testRepoIfPresent(): Promise<void> {
  console.log(`\n=== repo workspace: ${repoRoot} ===`)
  const overview = await loadPluginsOverview(repoRoot)
  if (overview.plugins.length === 0) {
    console.log('[info] no plugins in repo .ai-agent/plugins/ (skipped)')
    return
  }
  for (const p of overview.plugins) {
    console.log(
      `  ${p.name}: agents=${p.agents} commands=${p.commands} ` +
        `skills=${p.skills} mcp=${p.mcp} scope=${p.scope}`,
    )
  }
  if (overview.errors.length > 0) {
    console.log(
      '  errors:',
      overview.errors.map(e => `${e.type}: ${e.message}`).join('; '),
    )
  }
  const turn = await simulateChatTurn(repoRoot)
  console.log(
    `  active: +${turn.plugins.agentFiles.length} plugin agents, ` +
      `${turn.plugins.commandFiles.length} commands, ` +
      `${turn.plugins.skills.length} skills, ` +
      `${Object.keys(turn.mcpServers).length} MCP servers (merged)`,
  )
  console.log('[ok] repo plugin scan')
}

async function main(): Promise<void> {
  await testFullPluginLoad()
  await testManifestInlineMcp()
  await testMcpCollision()
  await testHotReloadPlugin()
  await testSettingsMcpOverridesPlugin()
  await testRepoIfPresent()
  console.log('\nAll plugin loading tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
