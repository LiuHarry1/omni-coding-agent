/**
 * Invoked-skills registry, SkillTool dual-channel, micro/full compact restore.
 * Run: npx tsx src/tests/test-invoked-skills-compact.ts
 */
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventBus } from '../core/event-bus.js'
import { createDefaultPermissionMode } from '../utils/permissions/permission-mode.js'
import type {
  DualChannelToolResult,
  Message,
  Session,
  ToolContext,
  ToolUseContext,
} from '../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import { SKILL_TOOL_NAME } from '../constants/tool_names.js'
import { BASH_TOOL_NAME } from '../constants/tool_names.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import { microCompact } from '../services/compact/microCompact.js'
import {
  buildPostCompactAttachmentMessages,
  createSkillAttachmentIfNeeded,
  POST_COMPACT_MAX_TOKENS_PER_SKILL,
  POST_COMPACT_SKILLS_TOKEN_BUDGET,
} from '../services/compact/post-compact-attachments.js'
import {
  addInvokedSkill,
  getInvokedSkillsForAgent,
  restoreInvokedSkillsFromMessages,
  type InvokedSkillInfo,
} from '../skills/invoked-skills.js'
import type { SkillDefinition } from '../skills/types.js'
import { createSkillTool } from '../tools/SkillTool/SkillTool.js'
import { getSkillToolPrompt } from '../tools/SkillTool/prompt.js'
import { COMMAND_NAME_TAG } from '../constants/xml.js'
import { formatSkillListing, MAX_LISTING_DESC_CHARS } from '../skills/index.js'
import { loadSkillsFromDisk } from '../skills/loadSkillsDir.js'
import { getAttachmentMessages } from '../utils/attachments.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'
import { resolveSlashCommand } from '../turn/prepare-chat-turn.js'
import { toolResultOutputToText } from '../utils/tool-result-content.js'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

function makeSession(): Session {
  return {
    id: 'invoked-skills-test',
    messages: [],
    createdAt: Date.now(),
    permissionMode: createDefaultPermissionMode(),
    agentType: null,
  }
}

function inlineSkill(name: string, body: string): SkillDefinition {
  return {
    name,
    description: 'test skill',
    source: 'user',
    filePath: `/tmp/${name}/SKILL.md`,
    baseDir: `/tmp/${name}`,
    context: 'inline',
    argumentNames: [],
    loadBody: async () => body,
  }
}

function forkSkill(name: string, body: string): SkillDefinition {
  return {
    ...inlineSkill(name, body),
    context: 'fork',
  }
}

function isDual(raw: unknown): raw is DualChannelToolResult<{
  success?: boolean
  skill_name?: string
  mode?: string
  text?: string
}> {
  return !!raw && typeof raw === 'object' && 'data' in raw
}

async function testInlineSkillTool(): Promise<void> {
  const session = makeSession()
  const body = 'Remember this procedure: always flibber the widget.'
  const def = createSkillTool([inlineSkill('demo-inline', body)], [])
  const tool = def.create(os.tmpdir(), {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    session,
  } as ToolContext) as {
    execute: (
      input: { skill: string; args?: string },
      opts?: unknown,
    ) => Promise<unknown>
  }

  const raw = await tool.execute({ skill: 'demo-inline' })
  assert.ok(isDual(raw), 'inline skill returns DualChannel')
  assert.equal(raw.data.mode, 'inline')
  assert.equal(raw.data.skill_name, 'demo-inline')
  assert.equal(raw.data.success, true)
  assert.equal(raw.newMessages?.length, 1)
  const follow = raw.newMessages![0]!
  assert.ok(isRoleMessage(follow) && follow.role === 'user')
  assert.equal(follow.isMeta, true)
  assert.ok(
    typeof follow.content === 'string' && follow.content.includes(body),
    'newMessages carry expanded SKILL.md',
  )

  const mapped = def.mapToolResultToToolResultBlockParam!(raw.data, 'tu_1')
  assert.equal(mapped.content, 'Launching skill: demo-inline')

  const registered = getInvokedSkillsForAgent(session, null)
  assert.equal(registered.length, 1)
  assert.equal(registered[0]!.skillName, 'demo-inline')
  assert.ok(registered[0]!.content.includes(body))
  console.log('[ok] inline SkillTool: Launching skill + newMessages + registry')
}

async function testForkDoesNotRegister(): Promise<void> {
  const session = makeSession()
  const def = createSkillTool([forkSkill('demo-fork', 'fork body')], [])
  const tool = def.create(os.tmpdir(), {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    session,
  } as ToolContext) as {
    execute: (
      input: { skill: string; args?: string },
      opts?: unknown,
    ) => Promise<unknown>
  }

  const raw = await tool.execute({ skill: 'demo-fork' })
  assert.equal(typeof raw, 'string')
  assert.ok(
    String(raw).startsWith('Error:'),
    'fork without runAgent returns error',
  )
  assert.equal(getInvokedSkillsForAgent(session, null).length, 0)
  console.log('[ok] fork SkillTool does not register invokedSkills')
}

function testMicroCompactLeavesSkillBody(): void {
  const body = 'S'.repeat(4000)
  const messages: Message[] = [{ role: 'user', content: 'start' }]
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: `bash-${i}`,
          toolName: BASH_TOOL_NAME,
          input: { command: `echo ${i}` },
        },
      ],
    })
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `bash-${i}`,
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: 'x'.repeat(2500) },
        },
      ],
    })
  }
  messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'skill-1',
        toolName: SKILL_TOOL_NAME,
        input: { skill_name: 'demo-inline' },
      },
    ],
  })
  messages.push({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'skill-1',
        toolName: SKILL_TOOL_NAME,
        output: { type: 'text', value: 'Launching skill: demo-inline' },
      },
    ],
  })
  messages.push({ role: 'user', content: body, isMeta: true })

  const result = microCompact(messages, 5)
  assert.ok(result.cleared > 0, 'micro cleared old bash results')
  const meta = result.messages.find(
    m =>
      isRoleMessage(m) && m.role === 'user' && m.isMeta && m.content === body,
  )
  assert.ok(meta, 'skill body in meta user message survives micro compact')
  const skillResult = result.messages.find(
    m =>
      isRoleMessage(m) &&
      m.role === 'tool' &&
      m.content.some(
        p =>
          p.toolCallId === 'skill-1' &&
          p.output.type === 'text' &&
          p.output.value === 'Launching skill: demo-inline',
      ),
  )
  assert.ok(skillResult, 'short Skill tool_result is untouched')
  console.log('[ok] micro compact leaves skill body + short tool_result')
}

function bashNoise(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: `bash-${i}`,
          toolName: BASH_TOOL_NAME,
          input: { command: `echo ${i}` },
        },
      ],
    })
    out.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `bash-${i}`,
          toolName: BASH_TOOL_NAME,
          output: { type: 'text', value: 'x'.repeat(2500) },
        },
      ],
    })
  }
  return out
}

/**
 * Real SKILL.md: old path (body in tool_result) is micro-cleared;
 * new path (Launching skill + meta body) survives.
 */
async function testRealSkillMicroContrast(): Promise<void> {
  const { skills } = await loadSkillsFromDisk(REPO_ROOT)
  const skill = skills.find(s => s.name === 'echarts-chart')
  assert.ok(skill, 'echarts-chart skill on disk')
  const session = makeSession()
  const def = createSkillTool([skill], [])
  const tool = def.create(REPO_ROOT, {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    session,
  } as ToolContext) as {
    execute: (
      input: { skill: string; args?: string },
      opts?: unknown,
    ) => Promise<unknown>
  }
  const raw = await tool.execute({ skill: 'echarts-chart' })
  assert.ok(isDual(raw))
  const follow = raw.newMessages![0]!
  assert.ok(isRoleMessage(follow) && follow.role === 'user')
  const body = follow.content
  assert.ok(typeof body === 'string' && body.length > 2000, 'real skill body')
  const marker = '[Old tool result content cleared to save context]'

  const oldPath: Message[] = [
    { role: 'user', content: 'start' },
    ...bashNoise(8),
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'skill-old',
          toolName: SKILL_TOOL_NAME,
          input: { skill_name: 'echarts-chart' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'skill-old',
          toolName: SKILL_TOOL_NAME,
          output: { type: 'text', value: body },
        },
      ],
    },
  ]
  const oldAfter = microCompact(oldPath, 0)
  let oldSkillText: string | undefined
  for (const m of oldAfter.messages) {
    if (!isRoleMessage(m) || m.role !== 'tool') continue
    const part = m.content.find(p => p.toolCallId === 'skill-old')
    if (part) oldSkillText = toolResultOutputToText(part.output)
  }
  assert.equal(oldSkillText, marker, 'old tool_result body is micro-cleared')

  const newPath: Message[] = [
    { role: 'user', content: 'start' },
    ...bashNoise(8),
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'skill-new',
          toolName: SKILL_TOOL_NAME,
          input: { skill_name: 'echarts-chart' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'skill-new',
          toolName: SKILL_TOOL_NAME,
          output: { type: 'text', value: 'Launching skill: echarts-chart' },
        },
      ],
    },
    { role: 'user', content: body, isMeta: true },
  ]
  const newAfter = microCompact(newPath, 0)
  assert.ok(newAfter.cleared > 0, 'micro still clears old bash')
  const kept = newAfter.messages.find(
    m =>
      isRoleMessage(m) && m.role === 'user' && m.isMeta && m.content === body,
  )
  assert.ok(kept, 'real SKILL.md in newMessages survives micro compact')
  const launch = newAfter.messages.find(
    m =>
      isRoleMessage(m) &&
      m.role === 'tool' &&
      m.content.some(
        p =>
          p.toolCallId === 'skill-new' &&
          p.output.type === 'text' &&
          p.output.value === 'Launching skill: echarts-chart',
      ),
  )
  assert.ok(launch, 'Launching skill tool_result stays')
  const registered = getInvokedSkillsForAgent(session, null)
  assert.equal(registered[0]?.skillName, 'echarts-chart')
  const att = createSkillAttachmentIfNeeded(registered)
  assert.ok(att && att.attachment.type === 'invoked_skills')
  assert.ok(
    att.attachment.skills[0]!.content.includes('ECharts Chart'),
    'full compact restore still has skill body',
  )
  console.log(
    `[ok] real echarts-chart: old path cleared (${body.length} chars), new path survives micro + invoked_skills`,
  )
}

async function testPostCompactInvokedSkills(): Promise<void> {
  const session = makeSession()
  addInvokedSkill(session, 'demo', '/tmp/demo/SKILL.md', 'body-one')
  const msgs = await buildPostCompactAttachmentMessages(os.tmpdir(), {
    toolNames: ['Read'],
    getInvokedSkills: () => getInvokedSkillsForAgent(session, null),
  })
  const types = msgs.filter(isAttachmentMessage).map(m => m.attachment.type)
  assert.ok(types.includes('invoked_skills'), 'invoked_skills present')
  assert.ok(!types.includes('skill_listing'), 'skill_listing not restored')

  const api = expandAttachmentMessagesForAPI(msgs)
  const text = JSON.stringify(api)
  assert.ok(
    text.includes('Continue to follow these guidelines'),
    'API expansion uses the invoked_skills prompt',
  )
  assert.ok(text.includes('### Skill: demo'))
  assert.ok(text.includes('body-one'))
  console.log('[ok] post-compact invoked_skills, no skill_listing')
}

function testBudgetAndTruncate(): void {
  const marker =
    '[... skill content truncated for compaction; use Read on the skill path if you need the full text]'
  const huge = 'H'.repeat(POST_COMPACT_MAX_TOKENS_PER_SKILL * 4 + 200)
  const truncated = createSkillAttachmentIfNeeded([
    {
      skillName: 'huge',
      skillPath: '/tmp/huge/SKILL.md',
      content: huge,
      invokedAt: 1,
      agentId: null,
    },
  ])
  assert.ok(truncated && isAttachmentMessage(truncated))
  assert.equal(truncated.attachment.type, 'invoked_skills')
  const content = truncated.attachment.skills[0]!.content
  assert.ok(content.endsWith(marker), 'over-budget skill is truncated')
  assert.ok(content.length < huge.length)

  const skills: InvokedSkillInfo[] = []
  for (let i = 0; i < 6; i++) {
    skills.push({
      skillName: `s${i}`,
      skillPath: `/tmp/s${i}`,
      content: 'T'.repeat(POST_COMPACT_MAX_TOKENS_PER_SKILL * 4),
      invokedAt: i,
      agentId: null,
    })
  }
  const packed = createSkillAttachmentIfNeeded(skills)
  assert.ok(packed && packed.attachment.type === 'invoked_skills')
  const names = packed.attachment.skills.map(s => s.name)
  assert.ok(!names.includes('s0'), 'oldest skill dropped under 25k budget')
  assert.ok(names.includes('s5'), 'most recent skill kept')
  assert.ok(
    packed.attachment.skills.length * POST_COMPACT_MAX_TOKENS_PER_SKILL <=
      POST_COMPACT_SKILLS_TOKEN_BUDGET,
  )
  console.log('[ok] per-skill 5k truncate + 25k budget drops oldest')
}

function testRestoreRoundTrip(): void {
  const live = makeSession()
  addInvokedSkill(live, 'kept', '/tmp/kept/SKILL.md', 'keep-this-body')
  const att = createSkillAttachmentIfNeeded(
    getInvokedSkillsForAgent(live, null),
  )
  assert.ok(att)

  const resumed = makeSession()
  restoreInvokedSkillsFromMessages(resumed, [
    att,
    {
      type: 'attachment',
      uuid: 'listing',
      timestamp: new Date().toISOString(),
      attachment: { type: 'skill_listing', content: '- foo: bar' },
    },
  ])
  const restored = getInvokedSkillsForAgent(resumed, null)
  assert.equal(restored.length, 1)
  assert.equal(restored[0]!.skillName, 'kept')
  assert.equal(restored[0]!.content, 'keep-this-body')
  assert.equal(resumed.skillListingAnnounced, true)

  const second = createSkillAttachmentIfNeeded(restored)
  assert.ok(second && second.attachment.type === 'invoked_skills')
  assert.equal(second.attachment.skills[0]!.name, 'kept')
  console.log('[ok] restore from attachment; second compact still has skills')
}

async function testSlashInlineRegisters(): Promise<void> {
  const session = makeSession()
  // echarts-chart is the only skill tracked in git (see .gitignore); every
  // other entry under .ai-agent/skills is machine-local.
  const slash = await resolveSlashCommand('/echarts-chart', REPO_ROOT, session)
  assert.equal(slash.forkSkill, null)
  assert.ok(
    slash.effectiveMessage.includes('reproducible data charts'),
    'slash inline expands skill body into the user prompt',
  )
  const registered = getInvokedSkillsForAgent(session, null)
  assert.equal(registered.length, 1)
  assert.equal(registered[0]!.skillName, 'echarts-chart')
  console.log('[ok] slash inline skill registers invokedSkills')
}

async function testListingFireOnce(): Promise<void> {
  const session = makeSession()
  const ctx: ToolUseContext = {
    cwd: REPO_ROOT,
    session,
    readFileState: new Map(),
    options: { tools: {} },
    skillListingContent: '- demo-inline (inline): test skill',
  }
  const first: Message[] = []
  for await (const m of getAttachmentMessages('hello', ctx, [])) first.push(m)
  const second: Message[] = []
  for await (const m of getAttachmentMessages('hello again', ctx, [])) {
    second.push(m)
  }
  const firstListing = first.filter(
    m => isAttachmentMessage(m) && m.attachment.type === 'skill_listing',
  )
  const secondListing = second.filter(
    m => isAttachmentMessage(m) && m.attachment.type === 'skill_listing',
  )
  assert.equal(firstListing.length, 1, 'first user turn announces listing')
  assert.equal(secondListing.length, 0, 'listing is fire-once')
  assert.equal(session.skillListingAnnounced, true)
  console.log('[ok] skill_listing fire-once survives subsequent turns')
}

function testSkillToolPromptMatchesCcContract(): void {
  const prompt = getSkillToolPrompt()
  assert.ok(
    prompt.includes('BLOCKING REQUIREMENT'),
    'invoke-first contract in Skill tool prompt',
  )
  assert.ok(prompt.includes('skill: "pdf"'), 'skill field example')
  assert.ok(prompt.includes('args:'), 'args field example')
  assert.ok(
    prompt.includes(`<${COMMAND_NAME_TAG}>`),
    'already-loaded command-name hint',
  )
  console.log('[ok] Skill tool prompt matches the invoke-first contract')
}

function testFormatSkillListingDiscoveryOnly(): void {
  const long =
    'Step 1 reset temp_invoices. Step 4 SSO in references/concur-sso.md. ' +
    'x'.repeat(400)
  const listing = formatSkillListing([
    {
      name: 'concur-expense',
      description: long,
      source: 'user',
      context: 'inline',
      argumentNames: [],
      loadBody: async () => '',
    },
  ])
  assert.equal(listing.startsWith('- concur-expense: '), true)
  assert.equal(
    listing.includes('(inline)'),
    false,
    'listing has no context mode',
  )
  const desc = listing.slice('- concur-expense: '.length)
  assert.ok(
    desc.length <= MAX_LISTING_DESC_CHARS,
    `listing desc ${desc.length} <= ${MAX_LISTING_DESC_CHARS}`,
  )
  assert.ok(desc.endsWith('\u2026'))
  console.log(
    '[ok] skill listing is discovery-only (250 char cap, - name: desc)',
  )
}

async function main(): Promise<void> {
  testSkillToolPromptMatchesCcContract()
  testFormatSkillListingDiscoveryOnly()
  await testInlineSkillTool()
  await testForkDoesNotRegister()
  testMicroCompactLeavesSkillBody()
  await testRealSkillMicroContrast()
  await testPostCompactInvokedSkills()
  testBudgetAndTruncate()
  testRestoreRoundTrip()
  await testSlashInlineRegisters()
  await testListingFireOnce()
  console.log('\nAll invoked-skills compact tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
