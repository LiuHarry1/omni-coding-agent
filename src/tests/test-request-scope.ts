/**
 * RequestScope — dual fields, isolation, fail-closed, settings.
 *   conda activate llm_ft && npx tsx src/tests/test-request-scope.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getAgentHome,
  getRequestCwd,
  getRequestScope,
  getShellHome,
  runWithRequestScope,
} from '../utils/request-scope.js'
import { getAppDirName, getUserAppDir } from '../utils/app-dir.js'
import { getAutoMemPath } from '../services/auto-memory/paths.js'
import { prepareShellSpawn } from '../core/shell/spawn-shell.js'
import {
  parseWritableScope,
  resetSettingsCache,
  resolveSettings,
} from '../core/settings-manager.js'
import {
  canAccessSession,
  canMutateSession,
  listSessions,
} from '../server/session.js'
import type { Session } from '../core/types.js'
import {
  computeProjectKey,
  registerSessionLocation,
  unregisterSessionLocation,
} from '../core/session-paths.js'
import {
  getSessionMemoryState,
  getSessionMemoryStatePath,
  persistSessionMemoryState,
  resetSessionMemoryState,
} from '../services/session-memory/index.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

/** SSO-style pin: agentHome === cwd. */
function withTenant<T>(workspace: string, fn: () => T): T {
  return runWithRequestScope({ agentHome: workspace, cwd: workspace }, fn)
}

const prevAuth = process.env.AUTH_ENABLED
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'request-scope-'))

try {
  // ── AUTH off: OS home ──────────────────────────────────────────────────
  delete process.env.AUTH_ENABLED
  assert(
    getAgentHome() === os.homedir(),
    'AUTH off: getAgentHome should be os.homedir()',
  )
  assert(
    getUserAppDir() === path.join(os.homedir(), getAppDirName()),
    'AUTH off: getUserAppDir under OS home',
  )
  console.log('ok: AUTH off uses OS home')

  // ── AUTH off: home ≠ cwd when scope is explicit (boot-like) ─────────────
  const projectCwd = path.join(tmpRoot, 'project')
  fs.mkdirSync(projectCwd, { recursive: true })
  runWithRequestScope({ agentHome: os.homedir(), cwd: projectCwd }, () => {
    assert(
      getAgentHome() === os.homedir(),
      'AUTH off: getAgentHome stays os.homedir()',
    )
    assert(
      getRequestCwd() === path.resolve(projectCwd),
      `AUTH off: getRequestCwd should be project, got ${getRequestCwd()}`,
    )
    assert(
      getAgentHome() !== getRequestCwd(),
      'AUTH off: agentHome and cwd may differ',
    )
    const scope = getRequestScope()
    assert(scope?.agentHome === path.resolve(os.homedir()), 'scope.agentHome')
    assert(scope?.cwd === path.resolve(projectCwd), 'scope.cwd')
  })
  console.log('ok: AUTH off dual fields (home ≠ cwd)')

  // ── AUTH on + no ALS: fail-closed ──────────────────────────────────────
  process.env.AUTH_ENABLED = 'true'
  let threw = false
  try {
    getAgentHome()
  } catch (e) {
    threw = true
    assert(
      (e as Error).message.includes('no agent home'),
      'fail-closed error should mention missing context',
    )
  }
  assert(threw, 'AUTH on without ALS must throw')
  let cwdThrew = false
  try {
    getRequestCwd()
  } catch {
    cwdThrew = true
  }
  assert(cwdThrew, 'AUTH on without ALS: getRequestCwd must throw')
  console.log('ok: AUTH on without ALS fails closed')

  // ── AUTH on: SSO pin — agentHome === cwd ───────────────────────────────
  const alice = path.join(tmpRoot, 'alice')
  const bob = path.join(tmpRoot, 'bob')
  fs.mkdirSync(alice, { recursive: true })
  fs.mkdirSync(bob, { recursive: true })

  withTenant(alice, () => {
    assert(
      getAgentHome() === path.resolve(alice),
      `SSO getAgentHome=${getAgentHome()}`,
    )
    assert(
      getRequestCwd() === path.resolve(alice),
      `SSO getRequestCwd=${getRequestCwd()}`,
    )
    assert(
      getAgentHome() === getRequestCwd(),
      'SSO: agentHome and cwd are the same pin',
    )
  })
  console.log('ok: SSO dual fields equal')

  // ── Dual-user isolation ────────────────────────────────────────────────
  const aliceApp = withTenant(alice, () => getUserAppDir())
  const bobApp = withTenant(bob, () => getUserAppDir())
  assert(
    aliceApp === path.join(alice, getAppDirName()),
    `alice app=${aliceApp}`,
  )
  assert(bobApp === path.join(bob, getAppDirName()), `bob app=${bobApp}`)
  assert(aliceApp !== bobApp, 'users must not share app dir')

  const aliceMem = withTenant(alice, () => getAutoMemPath({ cwd: alice }))
  const bobMem = withTenant(bob, () => getAutoMemPath({ cwd: bob }))
  assert(aliceMem.startsWith(aliceApp), 'alice memory under alice app')
  assert(bobMem.startsWith(bobApp), 'bob memory under bob app')
  assert(aliceMem !== bobMem, 'memory paths must not cross')

  const aliceOwnOverride = withTenant(alice, () =>
    getAutoMemPath({
      cwd: alice,
      trustedDirectory: path.join(alice, 'memory-custom'),
    }),
  )
  assert(
    aliceOwnOverride === path.join(alice, 'memory-custom'),
    'SSO user may override memory within own tenant home',
  )
  const aliceCrossTenantOverride = withTenant(alice, () =>
    getAutoMemPath({
      cwd: alice,
      trustedDirectory: path.join(bob, 'memory-stolen'),
    }),
  )
  assert(
    aliceCrossTenantOverride.startsWith(aliceApp) &&
      !aliceCrossTenantOverride.startsWith(bob),
    'SSO user must not grant memory access to another tenant home',
  )

  const aliceHomeEnv = withTenant(alice, () => {
    const prepared = prepareShellSpawn({
      shell: 'bash',
      userCommand: 'true',
    })
    return prepared.env.HOME
  })
  const bobHomeEnv = withTenant(bob, () => {
    const prepared = prepareShellSpawn({
      shell: 'bash',
      userCommand: 'true',
    })
    return prepared.env.HOME
  })
  assert(aliceHomeEnv === path.resolve(alice), `alice HOME=${aliceHomeEnv}`)
  assert(bobHomeEnv === path.resolve(bob), `bob HOME=${bobHomeEnv}`)

  const seen: string[] = []
  await Promise.all([
    withTenant(alice, async () => {
      await new Promise(r => setTimeout(r, 20))
      seen.push(getAgentHome())
    }),
    withTenant(bob, async () => {
      await new Promise(r => setTimeout(r, 5))
      seen.push(getAgentHome())
    }),
  ])
  assert(
    seen.includes(path.resolve(alice)) && seen.includes(path.resolve(bob)),
    `concurrent ALS leaked or missing: ${seen.join(',')}`,
  )
  console.log('ok: dual-user app-dir / memory / bash HOME isolated')

  // ── Settings: same path → single user source; SSO user writable ────────
  resetSettingsCache()
  fs.mkdirSync(path.join(alice, '.ai-agent'), { recursive: true })
  fs.writeFileSync(
    path.join(alice, '.ai-agent', 'settings.json'),
    JSON.stringify({
      autoMemoryEnabled: true,
      autoMemoryDirectory: path.join(alice, 'mem-custom'),
      disabledTools: ['web_fetch'],
    }) + '\n',
  )
  const resolved = withTenant(alice, () => resolveSettings(alice))
  assert(
    resolved.userPath === resolved.projectPath,
    'SSO cwd=home → userPath === projectPath',
  )
  const fileSources = resolved.sources.filter(
    s => s.scope === 'user' || s.scope === 'project',
  )
  assert(
    fileSources.length === 1 && fileSources[0]!.scope === 'user',
    `expected single user source, got ${fileSources.map(s => s.scope).join(',')}`,
  )
  assert(fileSources[0]!.applied, 'collapsed user source should be applied')
  assert(
    resolved.config.autoMemoryDirectory === path.join(alice, 'mem-custom'),
    'user-scope autoMemory.directory must not be stripped',
  )
  assert(
    parseWritableScope('user', { ssoMode: true }) === 'user',
    'SSO may write user scope',
  )
  console.log('ok: settings path collapse + SSO user writable')

  // ── Persistent Session Memory state stays in each tenant volume ────────
  const aliceSessionId = 'request-scope-alice-memory'
  const bobSessionId = 'request-scope-bob-memory'
  registerSessionLocation(aliceSessionId, {
    projectKey: computeProjectKey(undefined, alice),
    agentHome: alice,
  })
  registerSessionLocation(bobSessionId, {
    projectKey: computeProjectKey(undefined, bob),
    agentHome: bob,
  })
  getSessionMemoryState(aliceSessionId).notesGeneration = 1
  getSessionMemoryState(bobSessionId).notesGeneration = 2
  persistSessionMemoryState(aliceSessionId)
  persistSessionMemoryState(bobSessionId)
  const aliceStatePath = getSessionMemoryStatePath(aliceSessionId)
  const bobStatePath = getSessionMemoryStatePath(bobSessionId)
  assert(aliceStatePath.startsWith(alice), `alice state=${aliceStatePath}`)
  assert(bobStatePath.startsWith(bob), `bob state=${bobStatePath}`)
  assert(aliceStatePath !== bobStatePath, 'tenant states must not share path')
  resetSessionMemoryState(aliceSessionId)
  resetSessionMemoryState(bobSessionId)
  unregisterSessionLocation(aliceSessionId)
  unregisterSessionLocation(bobSessionId)
  console.log('ok: persistent session-memory state is tenant-isolated')

  // ── getShellHome worker fallback (AUTH + pinned env HOME, no ALS) ─────
  const prevHome = process.env.HOME
  process.env.HOME = bob
  assert(
    getShellHome() === path.resolve(bob),
    'getShellHome falls back to pinned process.env.HOME',
  )
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  console.log('ok: getShellHome worker env fallback')

  // ── Super list ≠ owner HOME (ACL still request-scoped) ─────────────────
  const fakeAliceSession = {
    id: 's-alice',
    ownerEmail: 'alice@example.com',
  } as Session
  assert(
    canAccessSession(fakeAliceSession, 'super@example.com', 'super'),
    'super may view another user session',
  )
  assert(
    !canAccessSession(fakeAliceSession, 'bob@example.com', 'user'),
    'peer user must not view alice session',
  )
  assert(
    !canMutateSession(fakeAliceSession, 'super@example.com', 'super'),
    'super may not mutate another user session',
  )
  assert(
    canMutateSession(fakeAliceSession, 'alice@example.com', 'super'),
    'super may mutate their own session',
  )
  assert(
    canMutateSession(fakeAliceSession, 'alice@example.com', 'user'),
    'owner may mutate their session',
  )
  const all = listSessions(undefined)
  assert(Array.isArray(all), 'listSessions(undefined) returns array')
  console.log('ok: super session ACL unchanged (view_all path)')

  console.log('\nAll request-scope checks passed.')
} finally {
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
  resetSettingsCache()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
