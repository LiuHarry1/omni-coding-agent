/**
 * Tool-level conformance checks for CronCreate, CronList, and CronDelete.
 * Run: npx tsx src/tests/test-coding-tools-cron.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '../core/types.js'
import { resetSettingsCache } from '../utils/settings/manager.js'
import { _setCronStorePathForTest } from '../services/cron/store.js'
import {
  definition as createDefinition,
  type CronCreateOutput,
} from '../tools/ScheduleCronTool/CronCreateTool.js'
import {
  definition as deleteDefinition,
  type CronDeleteOutput,
} from '../tools/ScheduleCronTool/CronDeleteTool.js'
import {
  definition as listDefinition,
  type CronListOutput,
} from '../tools/ScheduleCronTool/CronListTool.js'

type ToolResult<T> = { data: T }
type ExecutableTool<TInput, TOutput> = {
  execute: (input: TInput) => Promise<ToolResult<TOutput>>
  inputSchema: {
    safeParse: (input: unknown) => { success: boolean }
  }
}

function context(sessionId?: string): ToolContext {
  return {
    session: sessionId
      ? {
          id: sessionId,
          messages: [],
          createdAt: Date.now(),
          discoveredTools: new Set(),
          permissionMode: { mode: 'agent' },
          agentType: null,
        }
      : undefined,
  } as ToolContext
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-tools-cron-'))
const settingsDir = path.join(root, '.ai-agent')
const storePath = path.join(root, 'scheduled_tasks.json')

try {
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ scheduledTasks: { enabled: true } }),
  )
  _setCronStorePathForTest(storePath)
  resetSettingsCache()

  const create = createDefinition.create(
    root,
    context('session-a'),
  ) as unknown as ExecutableTool<
    { cron?: string; at?: string; prompt: string; recurring?: boolean },
    CronCreateOutput
  >
  const listA = listDefinition.create(
    root,
    context('session-a'),
  ) as unknown as ExecutableTool<Record<string, never>, CronListOutput>
  const listB = listDefinition.create(
    root,
    context('session-b'),
  ) as unknown as ExecutableTool<Record<string, never>, CronListOutput>
  const deleteA = deleteDefinition.create(
    root,
    context('session-a'),
  ) as unknown as ExecutableTool<{ id: string }, CronDeleteOutput>
  const deleteB = deleteDefinition.create(
    root,
    context('session-b'),
  ) as unknown as ExecutableTool<{ id: string }, CronDeleteOutput>

  assert.equal(
    create.inputSchema.safeParse({
      cron: '* * * * *',
      at: new Date(Date.now() + 60_000).toISOString(),
      prompt: 'invalid',
    }).success,
    false,
    'CronCreate must reject cron and at together',
  )
  assert.equal(
    create.inputSchema.safeParse({ prompt: 'invalid' }).success,
    false,
    'CronCreate must require exactly one schedule',
  )

  const recurring = await create.execute({
    cron: '*/5 * * * *',
    prompt: 'check status',
  })
  assert.equal(recurring.data.recurring, true)
  assert.match(recurring.data.message, /Scheduled recurring job/)
  assert.ok(createDefinition.outputSchema?.safeParse(recurring.data).success)
  assert.match(
    String(
      createDefinition.mapToolResultToToolResultBlockParam!(
        recurring.data,
        'cron-create',
      ).content,
    ),
    /Scheduled recurring job/,
  )

  const listed = await listA.execute({})
  assert.equal(listed.data.tasks.length, 1)
  assert.equal(listed.data.tasks[0]?.id, recurring.data.id)
  assert.match(listed.data.message, /check status/)
  assert.ok(listDefinition.outputSchema?.safeParse(listed.data).success)

  const otherSession = await listB.execute({})
  assert.deepEqual(otherSession.data.tasks, [])
  assert.equal(otherSession.data.message, 'No scheduled tasks in this session.')

  const crossSessionDelete = await deleteB.execute({ id: recurring.data.id })
  assert.equal(crossSessionDelete.data.removed, false)
  assert.match(crossSessionDelete.data.message, /No scheduled task/)

  const removed = await deleteA.execute({ id: recurring.data.id })
  assert.equal(removed.data.removed, true)
  assert.match(removed.data.message, /Cancelled scheduled task/)
  assert.ok(deleteDefinition.outputSchema?.safeParse(removed.data).success)
  assert.equal(
    (await deleteA.execute({ id: recurring.data.id })).data.removed,
    false,
  )

  const oneShot = await create.execute({
    at: new Date(Date.now() + 60_000).toISOString(),
    prompt: 'run once',
    recurring: false,
  })
  assert.equal(oneShot.data.recurring, false)
  assert.match(oneShot.data.message, /Scheduled one-shot/)

  for (const [definition, input, message] of [
    [createDefinition, { cron: '* * * * *', prompt: 'x' }, /active session/],
    [listDefinition, {}, /active session/],
    [deleteDefinition, { id: 'missing' }, /active session/],
  ] as const) {
    const tool = definition.create(root, context()) as unknown as {
      execute: (value: unknown) => Promise<unknown>
    }
    await assert.rejects(() => tool.execute(input), message)
  }

  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ scheduledTasks: { enabled: false } }),
  )
  resetSettingsCache()
  await assert.rejects(
    () =>
      create.execute({
        cron: '* * * * *',
        prompt: 'must be gated',
      }),
    /disabled/i,
  )

  console.log('ok CronCreate/CronList/CronDelete tool conformance')
} finally {
  _setCronStorePathForTest(null)
  resetSettingsCache()
  fs.rmSync(root, { recursive: true, force: true })
}
