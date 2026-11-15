/**
 * Hot-reload test: simulates each chat turn re-running loadPlugins +
 * registerSubagents (no server restart).
 *
 * Run: npx tsx src/tests/test-agent-hot-reload.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { loadPlugins } from '../services/plugins/loader.js'
import { registerSubagents, BUILTIN_AGENTS } from '../tools/AgentTool/index.js'
import { defaultRegistry } from '../tools.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

const BUILTIN_TYPES = BUILTIN_AGENTS.map(a => a.agentType)

function writeAgent(
  filePath: string,
  name: string,
  description: string,
  body = 'System prompt body.',
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  )
}

/** Mirrors turn/prepare-chat-turn.ts: plugins + registerSubagents each turn. */
async function simulateChatTurn(cwd: string) {
  const plugins = await loadPlugins(cwd)
  const result = await registerSubagents(
    defaultRegistry,
    cwd,
    plugins.agentFiles,
  )
  return {
    plugins: plugins.plugins.map(p => p.name),
    pluginAgentCount: plugins.agentFiles.length,
    activeTypes: result.activeAgents.map(a => a.agentType).sort(),
    activeAgents: result.activeAgents,
    errors: [...plugins.errors, ...result.errors],
  }
}

function assertHas(active: string[], name: string, turn: string): void {
  if (!active.includes(name)) {
    throw new Error(
      `[${turn}] expected active agent '${name}', got: ${active.join(', ')}`,
    )
  }
}

function assertMissing(active: string[], name: string, turn: string): void {
  if (active.includes(name)) {
    throw new Error(
      `[${turn}] agent '${name}' should not be active, got: ${active.join(', ')}`,
    )
  }
}

async function testHotReloadTmp(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hot-'))
  console.log(`\n=== hot-reload temp workspace: ${tmp} ===`)

  // Turn 1 — empty workspace: builtins only
  let turn = await simulateChatTurn(tmp)
  console.log(`Turn 1 (empty): agents=[${turn.activeTypes.join(', ')}]`)
  for (const b of BUILTIN_TYPES) assertHas(turn.activeTypes, b, 'turn1')
  assertMissing(turn.activeTypes, 'agents-dir-agent', 'turn1')
  assertMissing(turn.activeTypes, 'plugin-nested-agent', 'turn1')

  // Turn 2 — drop file in .ai-agent/agents/ (no restart)
  writeAgent(
    path.join(tmp, '.ai-agent', 'agents', 'agents-dir-agent.md'),
    'agents-dir-agent',
    'Hot reload from agents root',
  )
  turn = await simulateChatTurn(tmp)
  console.log(`Turn 2 (+agents root): agents=[${turn.activeTypes.join(', ')}]`)
  assertHas(turn.activeTypes, 'agents-dir-agent', 'turn2')

  // Turn 3 — nested under agents/
  writeAgent(
    path.join(tmp, '.ai-agent', 'agents', 'db', 'nested-agents-agent.md'),
    'nested-agents-agent',
    'Hot reload from nested agents dir',
  )
  turn = await simulateChatTurn(tmp)
  console.log(`Turn 3 (+agents/db/): agents=[${turn.activeTypes.join(', ')}]`)
  assertHas(turn.activeTypes, 'nested-agents-agent', 'turn3')

  // Turn 4 — plugin with root + nested agents (folder name with space)
  const pluginAgents = path.join(
    tmp,
    '.ai-agent',
    'plugins',
    'qa-plugin',
    'agents',
  )
  writeAgent(
    path.join(pluginAgents, 'plugin-root-agent.md'),
    'plugin-root-agent',
    'From plugin agents root',
  )
  writeAgent(
    path.join(pluginAgents, 'db test', 'plugin-nested-agent.md'),
    'plugin-nested-agent',
    'From plugin nested agents (space in folder)',
  )
  turn = await simulateChatTurn(tmp)
  console.log(
    `Turn 4 (+plugin qa-plugin): plugins=[${turn.plugins.join(', ')}] ` +
      `(+${turn.pluginAgentCount} plugin agents) agents=[${turn.activeTypes.join(', ')}]`,
  )
  if (!turn.plugins.includes('qa-plugin')) {
    throw new Error(
      `expected qa-plugin loaded, got: ${turn.plugins.join(', ')}`,
    )
  }
  if (turn.pluginAgentCount < 2) {
    throw new Error(
      `expected >=2 plugin agent files, got ${turn.pluginAgentCount}`,
    )
  }
  assertHas(turn.activeTypes, 'plugin-root-agent', 'turn4')
  assertHas(turn.activeTypes, 'plugin-nested-agent', 'turn4')

  // Turn 5 — project agent overrides plugin agent of same name
  writeAgent(
    path.join(tmp, '.ai-agent', 'agents', 'plugin-root-agent.md'),
    'plugin-root-agent',
    'Project override wins',
  )
  turn = await simulateChatTurn(tmp)
  const winner = turn.activeAgents.find(
    a => a.agentType === 'plugin-root-agent',
  )
  console.log(
    `Turn 5 (project override): plugin-root-agent source=${winner?.source} ` +
      `file=${path.basename(winner?.filePath ?? '')}`,
  )
  if (winner?.source !== 'project') {
    throw new Error(
      `expected project override for plugin-root-agent, source=${winner?.source}`,
    )
  }

  // Turn 6 — delete nested agent file; next turn should drop it
  fs.unlinkSync(
    path.join(tmp, '.ai-agent', 'agents', 'db', 'nested-agents-agent.md'),
  )
  turn = await simulateChatTurn(tmp)
  console.log(
    `Turn 6 (-deleted nested): agents=[${turn.activeTypes.join(', ')}]`,
  )
  assertMissing(turn.activeTypes, 'nested-agents-agent', 'turn6')
  assertHas(turn.activeTypes, 'agents-dir-agent', 'turn6')

  console.log('[ok] hot-reload temp workspace (6 turns)')
}

async function testRepoWorkspace(): Promise<void> {
  console.log(`\n=== repo workspace: ${repoRoot} ===`)
  const turn = await simulateChatTurn(repoRoot)
  console.log(
    `plugins=[${turn.plugins.join(', ') || '(none)'}] ` +
      `(+${turn.pluginAgentCount} plugin agents)`,
  )
  console.log(`agents=[${turn.activeTypes.join(', ')}]`)

  if (turn.activeTypes.includes('db-migrator')) {
    const db = turn.activeAgents.find(a => a.agentType === 'db-migrator')
    console.log(
      `[ok] db-migrator loaded from ${db?.source} (${path.basename(db?.filePath ?? '')})`,
    )
  } else {
    console.log('[skip] db-migrator not present in repo .ai-agent/agents/')
  }

  if (turn.pluginAgentCount > 0) {
    const pluginTypes = turn.activeAgents
      .filter(a => a.source === 'plugin')
      .map(a => a.agentType)
    console.log(`[ok] plugin agents active: ${pluginTypes.join(', ')}`)
  } else {
    console.log('[info] no plugin agents in repo (plugins dir may be absent)')
  }
}

async function main(): Promise<void> {
  await testHotReloadTmp()
  await testRepoWorkspace()
  console.log('\nAll agent hot-reload tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
