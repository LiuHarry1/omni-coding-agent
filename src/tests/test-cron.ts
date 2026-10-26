/**
 * Cron parser + scheduler + settings gate.
 * Run: npx tsx src/tests/test-cron.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resetSettingsCache } from '../core/settings-manager.js'
import {
  cronToHuman,
  nextCronRunMs,
  parseAbsoluteTimeMs,
  parseCronExpression,
} from '../services/cron/parse.js'
import { isScheduledTasksEnabled } from '../services/cron/settings.js'
import { scheduleCronTask } from '../services/cron/schedule.js'
import { createCronScheduler } from '../services/cron/scheduler.js'
import {
  _setCronStorePathForTest,
  addCronTask,
  CronStoreCorruptError,
  readCronTasks,
  removeCronTasks,
  removeTasksForSessions,
  writeCronTasks,
} from '../services/cron/store.js'
import type { FireResult, ScheduledTask } from '../services/cron/types.js'

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      _setCronStorePathForTest(null)
      resetSettingsCache()
      fs.rmSync(dir, { recursive: true, force: true })
    })
}

async function main() {
  assert.ok(parseCronExpression('*/5 * * * *'))
  assert.equal(parseCronExpression('nope'), null)
  assert.equal(parseCronExpression('* * *'), null)
  assert.equal(cronToHuman('*/5 * * * *'), 'Every 5 minutes')
  assert.equal(cronToHuman('0 * * * *'), 'Every hour')
  assert.ok(cronToHuman('0 15 * * *').startsWith('Every day at'))

  const from = Date.parse('2026-03-01T10:00:00')
  const next5 = nextCronRunMs('*/5 * * * *', from)
  assert.ok(next5 !== null && next5 > from)

  assert.equal(parseAbsoluteTimeMs('not-a-date'), null)
  assert.ok((parseAbsoluteTimeMs('2026-12-01T00:00:00Z') ?? 0) > 0)
  console.log('[ok] cron parse')

  await withTempDir(async dir => {
    const store = path.join(dir, 'scheduled_tasks.json')
    _setCronStorePathForTest(store)

    const task = addCronTask(
      {
        cron: '*/5 * * * *',
        prompt: 'check ci',
        sessionId: 'sess-1',
        cwd: dir,
        recurring: true,
      },
      from,
    )
    assert.match(task.id, /^[0-9a-f]{8}$/)
    assert.ok(task.nextRunAtMs > from)
    assert.equal(readCronTasks().length, 1)
    assert.equal(removeCronTasks([task.id]), 1)
    assert.equal(readCronTasks().length, 0)
    addCronTask(
      {
        cron: '*/5 * * * *',
        prompt: 'reset me',
        sessionId: 'reset-session',
        cwd: dir,
        recurring: true,
      },
      from,
    )
    addCronTask(
      {
        cron: '*/5 * * * *',
        prompt: 'keep me',
        sessionId: 'other-session',
        cwd: path.join(path.dirname(dir), 'other-workspace'),
        recurring: true,
      },
      from,
    )
    assert.equal(removeTasksForSessions(['reset-session'], dir), 1)
    assert.deepEqual(
      readCronTasks().map(row => row.sessionId),
      ['other-session'],
    )
    console.log('[ok] cron store')
  })

  await withTempDir(async dir => {
    const store = path.join(dir, 'scheduled_tasks.json')
    _setCronStorePathForTest(store)
    const garbage = '{not-json'
    fs.writeFileSync(store, garbage)
    assert.throws(() => readCronTasks(), CronStoreCorruptError)
    assert.throws(
      () =>
        addCronTask({
          cron: '* * * * *',
          prompt: 'wipe?',
          sessionId: 's',
          cwd: dir,
          recurring: true,
        }),
      CronStoreCorruptError,
    )
    assert.equal(fs.readFileSync(store, 'utf-8'), garbage)
    console.log('[ok] corrupt store is not overwritten')
  })

  await withTempDir(async dir => {
    const store = path.join(dir, 'scheduled_tasks.json')
    _setCronStorePathForTest(store)
    const settingsDir = path.join(dir, '.ai-agent')
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ scheduledTasks: { enabled: false } }),
    )
    resetSettingsCache()
    assert.equal(isScheduledTasksEnabled(dir), false)

    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ scheduledTasks: { enabled: true } }),
    )
    resetSettingsCache()
    assert.equal(isScheduledTasksEnabled(dir), true)

    const created = scheduleCronTask({
      cwd: dir,
      sessionId: 'sess-ui',
      prompt: 'nope',
      cron: '* * * * *',
    })
    assert.equal(created.ok, true)

    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ scheduledTasks: { enabled: false } }),
    )
    resetSettingsCache()
    const gated = scheduleCronTask({
      cwd: dir,
      sessionId: 'sess-ui',
      prompt: 'nope',
      cron: '* * * * *',
    })
    assert.equal(gated.ok, false)
    assert.equal(gated.code, 'disabled')
    console.log('[ok] scheduledTasks.enabled settings gate')
  })

  await withTempDir(async dir => {
    const store = path.join(dir, 'scheduled_tasks.json')
    _setCronStorePathForTest(store)

    const fired: string[] = []
    const now = Date.parse('2026-03-01T12:00:00')
    const timers: Array<{ at: number; fn: () => void }> = []

    const scheduler = createCronScheduler({
      nowMs: () => now,
      fire: async (task: ScheduledTask): Promise<FireResult> => {
        fired.push(task.id)
        return 'fired'
      },
      setTimeoutFn: ((fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn })
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })

    writeCronTasks([
      {
        id: 'abcd1234',
        cron: '* * * * *',
        prompt: 'tick',
        sessionId: 's',
        cwd: dir,
        recurring: true,
        createdAt: now - 60_000,
        nextRunAtMs: now - 1,
      },
    ])

    scheduler.start()
    await scheduler.tick()
    assert.deepEqual(fired, ['abcd1234'])
    scheduler.stop()
    console.log('[ok] scheduler tick fires due task')
  })

  await withTempDir(async dir => {
    const store = path.join(dir, 'scheduled_tasks.json')
    _setCronStorePathForTest(store)
    const settingsDir = path.join(dir, '.ai-agent')
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ scheduledTasks: { enabled: false } }),
    )
    resetSettingsCache()

    const fired: string[] = []
    const now = Date.now()
    writeCronTasks([
      {
        id: 'deadbeef',
        cron: '* * * * *',
        prompt: 'should not run',
        sessionId: 's',
        cwd: dir,
        recurring: true,
        createdAt: now,
        nextRunAtMs: now - 1,
      },
    ])

    const scheduler = createCronScheduler({
      nowMs: () => now,
      fire: async (task: ScheduledTask): Promise<FireResult> => {
        fired.push(task.id)
        return 'fired'
      },
      setTimeoutFn: ((_fn: () => void) => {
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })
    scheduler.start()
    await scheduler.tick()
    scheduler.stop()
    assert.deepEqual(fired, [])
    assert.equal(readCronTasks().length, 1)
    console.log('[ok] disabled settings skip fire')
  })

  console.log('[ok] cron tests')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})
