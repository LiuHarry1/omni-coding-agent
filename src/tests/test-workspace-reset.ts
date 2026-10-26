import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  bootstrapExecutionPlane,
  shutdownExecutionPlane,
} from '../execution/bootstrap.js'
import { seedUserWorkspaceIfNeeded } from '../core/workspace-seed.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import { createSession } from '../server/session.js'
import { resetTenantWorkspace } from '../server/routes/workspace-reset.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-reset-'))
const usersRoot = path.join(temp, 'users')
const seedDir = path.join(temp, 'seed')
const alice = path.join(usersRoot, 'alice_example.com')
const bob = path.join(usersRoot, 'bob_example.com')
const previous = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  USERS_ROOT: process.env.USERS_ROOT,
  WORKSPACE_SEED_DIR: process.env.WORKSPACE_SEED_DIR,
}

try {
  process.env.AUTH_ENABLED = 'true'
  process.env.USERS_ROOT = usersRoot
  process.env.WORKSPACE_SEED_DIR = seedDir
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(path.join(seedDir, 'welcome.txt'), 'fresh\n')
  fs.mkdirSync(alice, { recursive: true })
  fs.mkdirSync(bob, { recursive: true })
  seedUserWorkspaceIfNeeded(alice)
  fs.writeFileSync(path.join(alice, 'delete-me.txt'), 'old\n')
  fs.writeFileSync(path.join(bob, 'keep-me.txt'), 'safe\n')

  await bootstrapExecutionPlane({ startAuthProxy: false })
  const result = await runWithRequestScope(
    { agentHome: alice, cwd: alice },
    async () => {
      createSession('alice@example.com')
      return resetTenantWorkspace(alice, 'alice@example.com')
    },
  )

  assert.equal(result.sessionsRemoved, 1)
  assert.equal(fs.existsSync(path.join(alice, 'delete-me.txt')), false)
  assert.equal(
    fs.readFileSync(path.join(alice, 'welcome.txt'), 'utf-8'),
    'fresh\n',
  )
  assert.equal(
    fs.readFileSync(path.join(bob, 'keep-me.txt'), 'utf-8'),
    'safe\n',
  )
  await assert.rejects(
    () => resetTenantWorkspace(path.join(alice, 'nested'), 'alice@example.com'),
    /outside USERS_ROOT/,
  )
  console.log('[ok] workspace factory reset')
} finally {
  await shutdownExecutionPlane()
  if (previous.AUTH_ENABLED === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previous.AUTH_ENABLED
  if (previous.USERS_ROOT === undefined) delete process.env.USERS_ROOT
  else process.env.USERS_ROOT = previous.USERS_ROOT
  if (previous.WORKSPACE_SEED_DIR === undefined) {
    delete process.env.WORKSPACE_SEED_DIR
  } else {
    process.env.WORKSPACE_SEED_DIR = previous.WORKSPACE_SEED_DIR
  }
  fs.rmSync(temp, { recursive: true, force: true })
}
