import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSettingsCache } from '../../core/settings-manager.js'
import {
  createSession,
  deleteSession,
  setSessionWorkspace,
} from '../../session/store.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { fireScheduledTask } from './fire.js'
import { createCronScheduler } from './scheduler.js'
import { isScheduledTaskEnabled } from './settings.js'
import {
  _setCronStorePathForTest,
  readCronTasks,
  writeCronTasks,
} from './store.js'
import type { ScheduledTask } from './types.js'

const previous = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  USERS_ROOT: process.env.USERS_ROOT,
}

let root = ''
let agentHome = ''
let sessionId = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-scope-'))
  agentHome = path.join(root, 'users', 'alice')
  fs.mkdirSync(path.join(agentHome, '.ai-agent'), { recursive: true })
  fs.writeFileSync(
    path.join(agentHome, '.ai-agent', 'settings.json'),
    JSON.stringify({ scheduledTasks: { enabled: false } }),
  )
  process.env.AUTH_ENABLED = 'true'
  process.env.USERS_ROOT = path.join(root, 'users')
  _setCronStorePathForTest(path.join(root, 'scheduled_tasks.json'))
  resetSettingsCache()

  runWithRequestScope({ agentHome, cwd: agentHome }, () => {
    const session = createSession({
      agentHome,
      cwd: '/workspace/repo',
      ownerEmail: 'alice@example.com',
    })
    sessionId = session.id
    setSessionWorkspace(session.id, {
      environmentId: 'cloud:abcdef0123456789',
      cwd: '/workspace/repo',
    })
  })
})

afterEach(() => {
  if (sessionId) {
    runWithRequestScope({ agentHome, cwd: agentHome }, () =>
      deleteSession(sessionId),
    )
  }
  _setCronStorePathForTest(null)
  resetSettingsCache()
  fs.rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  sessionId = ''
})

function task(): ScheduledTask {
  return {
    id: 'deadbeef',
    prompt: 'do not run',
    sessionId,
    cwd: '/workspace/repo',
    environmentId: 'cloud:abcdef0123456789',
    recurring: true,
    cron: '* * * * *',
    createdAt: Date.now() - 60_000,
    nextRunAtMs: Date.now() - 1,
  }
}

describe('scheduled task request scope', () => {
  it('reads the owning user setting outside an HTTP request scope', async () => {
    const scheduled = task()

    expect(isScheduledTaskEnabled(scheduled)).toBe(false)
    expect(await fireScheduledTask(scheduled)).toBe('disabled')
  })

  it('keeps the background scheduler from firing a disabled user task', async () => {
    const scheduled = task()
    writeCronTasks([scheduled])
    const fire = vi.fn(async () => 'fired' as const)
    const scheduler = createCronScheduler({
      nowMs: () => Date.now(),
      fire,
      setTimeoutFn: vi.fn(() => 1) as unknown as typeof setTimeout,
      clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout,
    })

    scheduler.start()
    await scheduler.tick()
    scheduler.stop()

    expect(fire).not.toHaveBeenCalled()
    expect(readCronTasks()).toHaveLength(1)
  })
})
