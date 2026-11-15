import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../core/tool-registry.js'
import { EventBus } from '../core/event-bus.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import type {
  AgentDefinition,
  AnyTool,
  Session,
  ToolContext,
} from '../core/types.js'
import { createDefaultPermissionMode } from '../core/permission-mode.js'
import {
  BUILTIN_AGENTS,
  registerBuiltinSubagents,
} from '../tools/AgentTool/index.js'
import { createTaskTool } from '../tools/AgentTool/AgentTool.js'
import { createSkillTool } from '../tools/SkillTool/SkillTool.js'
import type { SkillDefinition } from '../skills/types.js'

type ExecutableTool = AnyTool & {
  execute: (input: unknown, options?: unknown) => Promise<unknown>
}

function session(mode: 'agent' | 'plan' = 'agent'): Session {
  return {
    id: `agent-skill-${mode}`,
    messages: [],
    createdAt: Date.now(),
    permissionMode:
      mode === 'agent'
        ? createDefaultPermissionMode()
        : { mode: 'plan', preMode: 'agent' },
    agentType: null,
  }
}

const registry = new ToolRegistry()
registerBuiltinSubagents(registry)
const agentDefinition = registry.get('Agent')
assert.ok(agentDefinition)
assert.equal(agentDefinition.isSubagent, true)
assert.ok(agentDefinition.outputSchema)
assert.ok(agentDefinition.mapToolResultToToolResultBlockParam)
assert.equal(
  agentDefinition.isConcurrencySafe?.({ subagent_type: 'explore' }),
  true,
)
assert.equal(
  agentDefinition.isConcurrencySafe?.({ subagent_type: 'general-purpose' }),
  false,
)

const context = (activeSession: Session) =>
  ({
    session: activeSession,
    eventBus: new EventBus(),
    wire: noopWireEmitter,
  }) as ToolContext

const agentTool = agentDefinition.create(
  process.cwd(),
  context(session()),
) as ExecutableTool
const exploreAgent = BUILTIN_AGENTS.find(agent =>
  agent.agentType.toLowerCase().includes('explore'),
)
assert.ok(exploreAgent)
assert.equal(
  await agentTool.execute({
    subagent_type: exploreAgent.agentType,
    description: 'Explore fixture',
    prompt: 'Inspect the fixture.',
  }),
  'Error: task tool requires runAgent + registry in ToolContext',
)

const planAgentTool = agentDefinition.create(
  process.cwd(),
  context(session('plan')),
) as ExecutableTool
const implementationAgent = BUILTIN_AGENTS.find(
  agent => !['explore', 'plan'].includes(agent.agentType.toLowerCase()),
)
assert.ok(implementationAgent)
assert.match(
  String(
    await planAgentTool.execute({
      subagent_type: implementationAgent.agentType,
      description: 'Mutate fixture',
      prompt: 'Edit the fixture.',
    }),
  ),
  /plan mode only allows/,
)

const fixtureAgent: AgentDefinition = {
  agentType: 'fixture-agent',
  whenToUse: 'Tests',
  description: 'Deterministic fixture agent',
  systemPrompt: 'You are a fixture.',
  tools: ['ReadFixture'],
}
const fixtureRegistry = new ToolRegistry()
fixtureRegistry.register({
  name: 'ReadFixture',
  description: 'Fixture read',
  create: () => ({ description: 'fixture read' }) as AnyTool,
})
const fixtureDefinition = createTaskTool([fixtureAgent])
const runPrompts: string[] = []
const fixtureContext = {
  ...context(session()),
  cwd: process.cwd(),
  sessionId: 'fixture-session',
  registry: fixtureRegistry,
  provider: {
    defaultModelId: () => 'fixture-model',
  },
  runAgent: async (
    prompt: string,
    options: { tools: Record<string, AnyTool>; throwOnError?: boolean },
  ) => {
    runPrompts.push(prompt)
    assert.deepEqual(Object.keys(options.tools), ['ReadFixture'])
    assert.equal(options.throwOnError, true)
    return 'fixture result'
  },
} as unknown as ToolContext
const fixtureTool = fixtureDefinition.create(
  process.cwd(),
  fixtureContext,
) as ExecutableTool
const fixtureResult = (await fixtureTool.execute(
  {
    subagent_type: 'fixture-agent',
    description: 'Run fixture',
    prompt: 'Inspect fixture.',
  },
  { toolCallId: 'fixture-call' },
)) as { data: { text: string } }
assert.match(fixtureResult.data.text, /^fixture result\n\nagentId: /)
assert.deepEqual(runPrompts, ['Inspect fixture.'])

const emptyTool = fixtureDefinition.create(process.cwd(), {
  ...fixtureContext,
  runAgent: async () => '   ',
} as unknown as ToolContext) as ExecutableTool
const emptyResult = (await emptyTool.execute(
  {
    subagent_type: 'fixture-agent',
    description: 'Run empty fixture',
    prompt: 'Return nothing.',
  },
  { toolCallId: 'empty-call' },
)) as { data: { text: string } }
assert.match(emptyResult.data.text, /completed but returned no output/i)

const skill: SkillDefinition = {
  name: 'coding-tools-fixture',
  description: 'Fixture skill',
  source: 'user',
  filePath: path.join(os.tmpdir(), 'coding-tools-fixture', 'SKILL.md'),
  baseDir: path.join(os.tmpdir(), 'coding-tools-fixture'),
  context: 'inline',
  argumentNames: [],
  loadBody: async () => 'Review $ARGUMENTS and return $1.',
}
const skillSession = session()
const skillDefinition = createSkillTool([skill], BUILTIN_AGENTS)
const skillTool = skillDefinition.create(
  process.cwd(),
  context(skillSession),
) as ExecutableTool
const skillResult = (await skillTool.execute({
  skill: '/coding-tools-fixture',
  args: 'alpha',
})) as {
  data: { success: boolean; skill_name: string; mode: string; body: string }
  newMessages: Array<{ content: string; isMeta: boolean }>
}
assert.equal(skillResult.data.success, true)
assert.equal(skillResult.data.skill_name, 'coding-tools-fixture')
assert.equal(skillResult.data.mode, 'inline')
assert.match(skillResult.data.body, /Review alpha and return/)
assert.equal(skillResult.newMessages[0]?.isMeta, true)
assert.match(skillResult.newMessages[0]?.content ?? '', /Review alpha/)
assert.equal(
  await skillTool.execute({ skill: 'missing-skill' }),
  'Unknown skill: missing-skill',
)
assert.ok(skillDefinition.outputSchema!.safeParse(skillResult.data).success)
assert.equal(
  skillDefinition.mapToolResultToToolResultBlockParam!(
    skillResult.data,
    'skill-1',
  ).content,
  'Launching skill: coding-tools-fixture',
)

const forkSkill: SkillDefinition = {
  ...skill,
  name: 'coding-tools-fork',
  context: 'fork',
  agent: 'fixture-agent',
  loadBody: async () => 'Fork body for $ARGUMENTS.',
}
const missingForkContext = createSkillTool([forkSkill], [fixtureAgent]).create(
  process.cwd(),
  context(session()),
) as ExecutableTool
assert.equal(
  await missingForkContext.execute({
    skill: 'coding-tools-fork',
    args: 'beta',
  }),
  'Error: skill fork requires runAgent + registry in ToolContext',
)

console.log('ok Agent registration/guards and inline Skill execution')
