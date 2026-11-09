/**
 * Unit checks for filesystem permissions.
 * Run: npx tsx src/tests/test-filesystem-permissions.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveFileInCwd } from '../utils/read/index.js'
import {
  coerceSanitizedProjectsPath,
  getBrowserLogsDir,
  getChatUploadsRoot,
  getProjectsRoot,
  isReadableInternalPath,
} from '../core/session-paths.js'
import { FILE_READ_TOOL_NAME } from '../constants/tool_names.js'
import { definition as fileReadDef } from '../tools/FileReadTool/FileReadTool.js'
import { createCanUseTool } from '../core/can-use-tool.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import {
  addAlwaysAllowDirectory,
  assertAccessible,
  assertAccessibleResolved,
  checkReadPermission,
  checkWritePermission,
  createFilesystemPermissionContext,
  resolveFilesystemPermissionMode,
  settingsPermissionOpts,
} from '../utils/permissions/filesystem.js'

function expectThrow(fn: () => void, label: string) {
  try {
    fn()
    throw new Error(`EXPECTED_THROW: ${label}`)
  } catch (e) {
    if ((e as Error).message.startsWith('EXPECTED_THROW')) throw e
  }
}

const prevAuth = process.env.AUTH_ENABLED

try {
  process.env.AUTH_ENABLED = ''
  if (resolveFilesystemPermissionMode() !== 'default') {
    throw new Error('desktop AUTH unset should be default')
  }

  process.env.AUTH_ENABLED = 'true'
  if (resolveFilesystemPermissionMode() !== 'dontAsk') {
    throw new Error('AUTH_ENABLED implies dontAsk')
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsperm-'))
  const inside = path.join(root, 'a.txt')
  const outside = path.join(os.tmpdir(), `fsperm-out-${Date.now()}.txt`)
  fs.writeFileSync(inside, 'ok')
  fs.writeFileSync(outside, 'secret')

  const resolvedOutside = resolveFileInCwd(root, outside)
  if ('error' in resolvedOutside) {
    throw new Error(
      `resolve should succeed outside cwd: ${resolvedOutside.error}`,
    )
  }
  if (path.resolve(resolvedOutside.abs) !== path.resolve(outside)) {
    throw new Error('resolve outside cwd should keep absolute path')
  }

  const relOk = resolveFileInCwd(root, 'a.txt')
  if ('error' in relOk) throw new Error(relOk.error)
  if (relOk.displayPath !== 'a.txt') throw new Error('in-cwd displayPath')

  process.env.AUTH_ENABLED = ''
  const desktop = createFilesystemPermissionContext(root)
  if (desktop.mode !== 'default') throw new Error('desktop mode')
  if (checkReadPermission(inside, desktop).behavior !== 'allow') {
    throw new Error('in-cwd read should allow')
  }
  if (checkWritePermission(inside, desktop).behavior !== 'allow') {
    throw new Error('in-cwd write should allow')
  }
  const outsideRead = checkReadPermission(outside, desktop)
  if (outsideRead.behavior !== 'ask') {
    throw new Error('desktop outside read should ask')
  }
  if (checkWritePermission(outside, desktop).behavior !== 'ask') {
    throw new Error('desktop outside write should ask')
  }
  // HTTP / execute-time: default mode does not throw.
  assertAccessible(outside, desktop, 'read')
  assertAccessible(outside, desktop, 'write')

  const dir = addAlwaysAllowDirectory(desktop, outside)
  if (checkReadPermission(outside, desktop).behavior !== 'allow') {
    throw new Error(`Always allow should auto-allow ${dir}`)
  }

  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsperm-extra-'))
  const extraFile = path.join(extraDir, 'ok.txt')
  const extraEnv = path.join(extraDir, '.env')
  fs.writeFileSync(extraFile, 'ok')
  fs.writeFileSync(extraEnv, 'SECRET=1')
  const envInside = path.join(root, '.env')
  fs.writeFileSync(envInside, 'SECRET=1')
  const withDeny = createFilesystemPermissionContext(root, {
    additionalWorkingDirectories: [extraDir],
    deny: ['Read(.env)', 'Edit(.env)', 'Write(.env)'],
  })
  if (checkReadPermission(envInside, withDeny).behavior !== 'deny') {
    throw new Error('Read(.env) deny should win inside workspace')
  }
  if (checkWritePermission(envInside, withDeny).behavior !== 'deny') {
    throw new Error('Edit/Write(.env) deny should win inside workspace')
  }
  if (checkReadPermission(extraFile, withDeny).behavior !== 'allow') {
    throw new Error('deny .env should not block unrelated Always-allow path')
  }
  if (checkReadPermission(extraEnv, withDeny).behavior !== 'deny') {
    throw new Error('Read(.env) should deny in Always-allow extra dir')
  }

  const withAllow = createFilesystemPermissionContext(root, {
    allow: ['Read', `Read(${outside.replace(/\\/g, '/')})`],
  })
  if (checkReadPermission(outside, withAllow).behavior !== 'allow') {
    throw new Error(
      'tool-wide / absolute allow should grant outside path on desktop',
    )
  }

  // Relative allow rules use all working dirs (same as deny).
  const withRelAllow = createFilesystemPermissionContext(root, {
    additionalWorkingDirectories: [extraDir],
    allow: ['Read(ok.txt)'],
  })
  if (checkReadPermission(extraFile, withRelAllow).behavior !== 'allow') {
    throw new Error(
      'relative allow should match under additionalWorkingDirectories',
    )
  }

  // A leading `/` is project-root-relative, not filesystem-absolute.
  const nestedDir = path.join(root, 'nested')
  const nestedFile = path.join(nestedDir, 'a.txt')
  fs.mkdirSync(nestedDir, { recursive: true })
  fs.writeFileSync(nestedFile, 'nested')
  const withSlashAllow = createFilesystemPermissionContext(root, {
    allow: ['Read(/nested/**)'],
  })
  if (checkReadPermission(nestedFile, withSlashAllow).behavior !== 'allow') {
    throw new Error('Read(/nested/**) should allow under project root')
  }
  if (checkReadPermission(outside, withSlashAllow).behavior !== 'ask') {
    throw new Error('Read(/nested/**) must not treat pattern as FS-absolute')
  }

  const lockedOpts = settingsPermissionOpts({
    defaultMode: 'dontAsk',
    additionalDirectories: [extraDir],
    allow: ['Read'],
  })
  if (lockedOpts.mode !== 'dontAsk') {
    throw new Error('desktop defaultMode dontAsk should set mode')
  }
  if (!lockedOpts.additionalWorkingDirectories?.includes(extraDir)) {
    throw new Error('desktop dontAsk should keep additionalDirectories')
  }
  if ((lockedOpts.allow ?? []).length !== 0) {
    throw new Error('dontAsk should drop allow rules')
  }
  const locked = createFilesystemPermissionContext(root, lockedOpts)
  if (locked.mode !== 'dontAsk') throw new Error('locked context mode')
  if (checkReadPermission(inside, locked).behavior !== 'allow') {
    throw new Error('defaultMode dontAsk should allow workspace')
  }
  if (checkReadPermission(extraFile, locked).behavior !== 'allow') {
    throw new Error('defaultMode dontAsk should allow additionalDirectories')
  }
  expectThrow(
    () => assertAccessible(outside, locked, 'read'),
    'defaultMode dontAsk read outside',
  )
  const lockedCanUse = createCanUseTool({
    cwd: root,
    permissionContext: locked,
    getDefinition: name =>
      name === FILE_READ_TOOL_NAME ? fileReadDef : undefined,
    wire: noopWireEmitter,
  })
  const lockedDenied = await lockedCanUse(FILE_READ_TOOL_NAME, {
    file_path: outside,
  })
  if (lockedDenied.behavior !== 'deny') {
    throw new Error(
      'defaultMode dontAsk should deny File tools outside workspace',
    )
  }

  const planOpts = settingsPermissionOpts({
    defaultMode: 'plan' as 'default',
  })
  if (planOpts.mode !== 'default') {
    throw new Error('legacy defaultMode plan should map to filesystem default')
  }
  const acceptOpts = settingsPermissionOpts({
    defaultMode: 'acceptEdits' as 'default',
  })
  if (acceptOpts.mode !== 'default') {
    throw new Error(
      'legacy defaultMode acceptEdits should map to filesystem default',
    )
  }
  const bypassOpts = settingsPermissionOpts({
    defaultMode: 'bypassPermissions',
    deny: ['Read(.env)'],
  })
  if (bypassOpts.mode !== 'bypassPermissions') {
    throw new Error('defaultMode bypassPermissions should set mode')
  }
  const bypass = createFilesystemPermissionContext(root, bypassOpts)
  if (checkReadPermission(outside, bypass).behavior !== 'allow') {
    throw new Error('bypassPermissions should allow outside File reads')
  }
  if (checkReadPermission(envInside, bypass).behavior !== 'deny') {
    throw new Error('bypassPermissions should still honor deny')
  }

  const projectsRoot = getProjectsRoot()
  const sessionsPath = path.join(projectsRoot, 'perm-test.txt')
  fs.mkdirSync(projectsRoot, { recursive: true })
  fs.writeFileSync(sessionsPath, 'task-out')
  try {
    if (checkReadPermission(sessionsPath, desktop).behavior !== 'allow') {
      throw new Error('projects/ internal path should allow read')
    }
  } finally {
    try {
      fs.unlinkSync(sessionsPath)
    } catch {}
  }

  const logsRoot = getBrowserLogsDir()
  if (logsRoot.split(path.sep).includes('projects')) {
    throw new Error('browser-logs must not live under projects/')
  }
  const logPath = path.join(logsRoot, 'perm-test.log')
  fs.mkdirSync(logsRoot, { recursive: true })
  fs.writeFileSync(logPath, 'snap')
  try {
    if (checkReadPermission(logPath, desktop).behavior !== 'allow') {
      throw new Error('browser-logs/ internal path should allow read')
    }
    if (!isReadableInternalPath(logPath)) {
      throw new Error('isReadableInternalPath should cover browser-logs')
    }
  } finally {
    try {
      fs.unlinkSync(logPath)
    } catch {}
  }

  const uploadsRoot = getChatUploadsRoot()
  if (uploadsRoot.split(path.sep).includes('projects')) {
    throw new Error('uploads must not live under projects/')
  }
  const uploadPath = path.join(uploadsRoot, 'perm-sid', 'att.pdf')
  fs.mkdirSync(path.dirname(uploadPath), { recursive: true })
  fs.writeFileSync(uploadPath, 'pdf')
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fsperm-other-'))
  try {
    if (checkReadPermission(uploadPath, desktop).behavior !== 'allow') {
      throw new Error('uploads/ internal path should allow read')
    }
    if (!isReadableInternalPath(uploadPath)) {
      throw new Error('isReadableInternalPath should cover uploads')
    }
    const otherUpload = path.join(
      otherHome,
      '.ai-agent',
      'uploads',
      'sid',
      'x.pdf',
    )
    fs.mkdirSync(path.dirname(otherUpload), { recursive: true })
    fs.writeFileSync(otherUpload, 'x')
    if (isReadableInternalPath(otherUpload)) {
      throw new Error('uploads under another agentHome must not be readable')
    }
  } finally {
    try {
      fs.unlinkSync(uploadPath)
    } catch {}
    fs.rmSync(otherHome, { recursive: true, force: true })
  }

  process.env.AUTH_ENABLED = 'true'
  await runWithRequestScope({ agentHome: root, cwd: root }, async () => {
    const skillScript = path.join(root, '.ai-agent', 'skills', 'demo', 'run.sh')
    fs.mkdirSync(path.dirname(skillScript), { recursive: true })
    fs.writeFileSync(skillScript, 'echo ok\n')
    if (!isReadableInternalPath(skillScript)) {
      throw new Error('user skills should be readable from the agent host')
    }
    const pluginReference = path.join(
      root,
      '.ai-agent',
      'plugins',
      'pdf-tools',
      'skills',
      'fill-form',
      'reference.md',
    )
    fs.mkdirSync(path.dirname(pluginReference), { recursive: true })
    fs.writeFileSync(pluginReference, '# reference\n')
    if (!isReadableInternalPath(pluginReference)) {
      throw new Error(
        'plugin skill files should be readable from the agent host',
      )
    }
    const lookalike = path.join(root, '.ai-agent', 'plugins-evil', 'x.md')
    fs.mkdirSync(path.dirname(lookalike), { recursive: true })
    fs.writeFileSync(lookalike, 'x')
    if (isReadableInternalPath(lookalike)) {
      throw new Error('a sibling of plugins/ must not match the plugins root')
    }
    const settingsFile = path.join(root, '.ai-agent', 'settings.json')
    fs.writeFileSync(settingsFile, '{}')
    if (isReadableInternalPath(settingsFile)) {
      throw new Error('settings.json must stay outside the skill read root')
    }
    const cloud = createFilesystemPermissionContext(root)
    if (cloud.mode !== 'dontAsk') throw new Error('cloud mode')
    assertAccessible(inside, cloud, 'read')
    assertAccessible(inside, cloud, 'write')
    expectThrow(
      () => assertAccessible(outside, cloud, 'read'),
      'dontAsk read outside',
    )
    expectThrow(
      () => assertAccessible(outside, cloud, 'write'),
      'dontAsk write outside',
    )

    const canUse = createCanUseTool({
      cwd: root,
      permissionContext: cloud,
      getDefinition: name =>
        name === FILE_READ_TOOL_NAME ? fileReadDef : undefined,
      wire: noopWireEmitter,
    })
    const denied = await canUse(FILE_READ_TOOL_NAME, { file_path: outside })
    if (denied.behavior !== 'deny') {
      throw new Error('dontAsk createCanUseTool should deny outside path')
    }
    const allowed = await canUse(FILE_READ_TOOL_NAME, { file_path: inside })
    if (allowed.behavior !== 'allow') {
      throw new Error('dontAsk createCanUseTool should allow in-cwd')
    }

    const ssoOpts = settingsPermissionOpts({
      additionalDirectories: [extraDir],
      allow: ['Read'],
      deny: ['Read(.env)'],
      defaultMode: 'bypassPermissions',
    })
    if (ssoOpts.mode !== 'dontAsk') {
      throw new Error('SSO should force dontAsk over bypassPermissions')
    }
    if ((ssoOpts.allow ?? []).length !== 0) {
      throw new Error('SSO should drop allow')
    }
    if ((ssoOpts.additionalWorkingDirectories ?? []).length !== 0) {
      throw new Error('SSO should drop additionalDirectories')
    }
    if (!ssoOpts.deny?.includes('Read(.env)')) {
      throw new Error('SSO should keep deny')
    }

    const cloudDeny = createFilesystemPermissionContext(root, {
      deny: ['Read(.env)'],
      allow: ['Read'],
    })
    if (checkReadPermission(envInside, cloudDeny).behavior !== 'deny') {
      throw new Error('dontAsk should still honor deny inside workspace')
    }
    if (checkReadPermission(outside, cloudDeny).behavior !== 'ask') {
      throw new Error('dontAsk should ignore allow rules')
    }
    expectThrow(
      () => assertAccessible(envInside, cloudDeny, 'read'),
      'dontAsk deny .env',
    )

    const link = path.join(root, 'escape-link')
    try {
      fs.symlinkSync(outside, link)
      expectThrow(
        () => assertAccessibleResolved(link, cloud, 'read'),
        'symlink realpath',
      )
      const linkDecision = checkReadPermission(link, cloud)
      if (linkDecision.behavior !== 'ask') {
        throw new Error('workspace symlink to outside should not auto-allow')
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        console.log('skip symlink test (EPERM on this platform)')
      } else if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        console.log('skip symlink test (EEXIST)')
      } else {
        throw e
      }
    } finally {
      try {
        fs.unlinkSync(link)
      } catch {}
    }
  })

  fs.unlinkSync(outside)
  fs.rmSync(extraDir, { recursive: true, force: true })

  const wrongKey = 'C--Users-harry.liu--ws'
  const realKey = 'C--Users-harry-liu--ws'
  const coerced = coerceSanitizedProjectsPath(
    path.join(
      root,
      '.ai-agent',
      'projects',
      wrongKey,
      'sid',
      'browser',
      'snap.txt',
    ),
  )
  const coercedKey = coerced
    ? coerced.split(path.sep).find((_, i, arr) => arr[i - 1] === 'projects')
    : undefined
  if (coercedKey !== realKey) {
    throw new Error(`coerceSanitizedProjectsPath failed: ${coerced}`)
  }
  const snapDir = path.join(
    root,
    '.ai-agent',
    'projects',
    realKey,
    'sid',
    'browser',
  )
  fs.mkdirSync(snapDir, { recursive: true })
  const snapFile = path.join(snapDir, 'snap.txt')
  fs.writeFileSync(snapFile, 'ok')
  const asked = path.join(
    root,
    '.ai-agent',
    'projects',
    wrongKey,
    'sid',
    'browser',
    'snap.txt',
  )
  const hit = resolveFileInCwd(root, asked, { allowOutsideWorkspace: true })
  if ('error' in hit || path.normalize(hit.abs) !== path.normalize(snapFile)) {
    throw new Error(
      `Read should follow sanitized project key, got ${JSON.stringify(hit)}`,
    )
  }

  const sid = '59a89bca-a1ed-4fe6-932f-f822b19e0409'
  const collapsedKey = 'C--Users-harry-liu--ai-agent-workspace'
  const collapsedDir = path.join(
    root,
    '.ai-agent',
    'projects',
    collapsedKey,
    sid,
    'browser',
  )
  fs.mkdirSync(collapsedDir, { recursive: true })
  const collapsedFile = path.join(collapsedDir, 'snapshot-x.txt')
  fs.writeFileSync(collapsedFile, 'ok')
  const mangledNested = path.join(
    root,
    '.ai-agent',
    'projects',
    'C--Users',
    'harry.liu',
    '.ai-agent',
    'workspace',
    sid,
    'browser',
    'snapshot-x.txt',
  )
  const collapsed = coerceSanitizedProjectsPath(mangledNested)
  if (
    !collapsed ||
    path.normalize(collapsed) !== path.normalize(collapsedFile)
  ) {
    throw new Error(`nested project-key collapse failed: ${collapsed}`)
  }
  const nestedHit = resolveFileInCwd(root, mangledNested, {
    allowOutsideWorkspace: true,
  })
  if (
    'error' in nestedHit ||
    path.normalize(nestedHit.abs) !== path.normalize(collapsedFile)
  ) {
    throw new Error(
      `Read should collapse nested cwd-into-projects path, got ${JSON.stringify(nestedHit)}`,
    )
  }

  fs.rmSync(root, { recursive: true, force: true })
  console.log('filesystem permission tests OK')
} finally {
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
}
