import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agent-lazy.js', () => ({
  getRunAgent: async () => async () => {},
}))
vi.mock('../../turn/run-chat-turn.js', () => ({
  runChatTurn: vi.fn(async () => {
    throw new Error('turn failed after running tools')
  }),
}))

import { resetSettingsCache } from '../../core/settings-manager.js'
import {
  createSession,
  deleteSession,
  setSessionWorkspace,
} from '../../session/store.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { fireScheduledTask } from './fire.js'
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
let repo = ''
let sessionId = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-fire-'))
  agentHome = path.join(root, 'users', 'alice')
  repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(agentHome, '.ai-agent'), { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  process.env.AUTH_ENABLED = 'true'
  process.env.USERS_ROOT = path.join(root, 'users')
  _setCronStorePathForTest(path.join(root, 'scheduled_tasks.json'))
  resetSettingsCache()

  runWithRequestScope({ agentHome, cwd: repo }, () => {
    const session = createSession({
      agentHome,
      cwd: repo,
      ownerEmail: 'alice@example.com',
    })
    sessionId = session.id
    setSessionWorkspace(session.id, { environmentId: 'local', cwd: repo })
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

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'deadbeef',
    prompt: 'run once',
    sessionId,
    cwd: repo,
    workspace: { environmentId: 'local', cwd: repo },
    recurring: false,
    createdAt: Date.now() - 60_000,
    nextRunAtMs: Date.now() - 1,
    ...overrides,
  }
}

describe('fireScheduledTask failure handling', () => {
  it('drops a failed one-shot task instead of replaying it', async () => {
    const scheduled = task({ atMs: Date.now() - 1 })
    writeCronTasks([scheduled])

    expect(await fireScheduledTask(scheduled)).toBe('error')
    expect(readCronTasks()).toHaveLength(0)
  })

  it('moves a failed recurring task to its next slot', async () => {
    const now = Date.now()
    const scheduled = task({ recurring: true, cron: '0 * * * *' })
    writeCronTasks([scheduled])

    expect(await fireScheduledTask(scheduled, now)).toBe('error')
    const [stored] = readCronTasks()
    expect(stored?.lastFiredAt).toBe(now)
    expect(stored!.nextRunAtMs).toBeGreaterThan(now)
  })

  it('removes a task whose session is bound to another workspace', async () => {
    const scheduled = task({
      workspace: { environmentId: 'ssh:other-host', cwd: repo },
    })
    writeCronTasks([scheduled])

    expect(await fireScheduledTask(scheduled)).toBe('missing')
    expect(readCronTasks()).toHaveLength(0)
  })
})
