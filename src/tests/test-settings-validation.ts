/**
 * Settings Zod validation — strict schema rejects invalid types.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  patchSettings,
  resolveSettings,
  resetSettingsCache,
} from '../utils/settings/manager.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-val-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    resetSettingsCache()
  }
}

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      compaction: { enabled: 'yes' },
    }),
  )
  const resolved = resolveSettings(dir)
  assert.ok(
    resolved.validationErrors.length > 0,
    'invalid enabled type rejected',
  )
  assert.equal(
    resolved.config.compaction.enabled,
    true,
    'defaults kept when layer invalid',
  )
  console.log('[ok] invalid compaction.enabled rejected')
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      compaction: { enabled: false, contextWindow: 100_000 },
      disabledTools: ['Bash'],
    }),
  )
  const resolved = resolveSettings(dir)
  const projectErrors = resolved.validationErrors.filter(e =>
    e.file.includes(dir),
  )
  assert.equal(projectErrors.length, 0)
  assert.equal(resolved.config.compaction.enabled, false)
  assert.equal(resolved.config.compaction.contextWindow, 100_000)
  assert.deepEqual(resolved.config.disabledTools, ['Bash'])
  console.log('[ok] valid settings applied')
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      scheduledTasks: { enabled: false },
    }),
  )
  const resolved = resolveSettings(dir)
  const projectErrors = resolved.validationErrors.filter(e =>
    e.file.includes(dir),
  )
  assert.equal(projectErrors.length, 0)
  assert.equal(resolved.config.scheduledTasks?.enabled, false)
  console.log('[ok] scheduledTasks.enabled=false applied')
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  const extra = path.join(os.tmpdir(), 'always-allow-extra')
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      permissions: {
        additionalDirectories: [extra, '~/Projects'],
        allow: ['Read(docs/**)'],
        deny: ['Read(.env)', 'Edit(.env)', 'Write(.env)'],
        defaultMode: 'dontAsk',
      },
    }),
  )
  const resolved = resolveSettings(dir)
  const projectErrors = resolved.validationErrors.filter(e =>
    e.file.includes(dir),
  )
  assert.equal(projectErrors.length, 0)
  assert.ok(
    resolved.config.permissions?.additionalDirectories?.includes(extra),
    'additionalDirectories applied',
  )
  assert.ok(
    resolved.config.permissions?.allow?.includes('Read(docs/**)'),
    'allow applied',
  )
  assert.ok(
    resolved.config.permissions?.deny?.includes('Read(.env)'),
    'deny applied',
  )
  assert.equal(resolved.config.permissions?.defaultMode, 'dontAsk')
  console.log(
    '[ok] permissions.allow / deny / additionalDirectories / defaultMode applied',
  )
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      permissions: { defaultMode: 'acceptEdits' },
    }),
  )
  const resolved = resolveSettings(dir)
  const projectErrors = resolved.validationErrors.filter(e =>
    e.file.includes(dir),
  )
  assert.equal(projectErrors.length, 0, 'legacy acceptEdits should coerce')
  assert.equal(
    resolved.config.permissions?.defaultMode,
    'default',
    'acceptEdits coerces to default',
  )
  console.log('[ok] permissions.defaultMode acceptEdits coerces to default')
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      disabledTools: ['Bash'],
      lspServers: {
        jdtls: {
          command: 'jdtls',
          args: ['-data', '.jdtls-data'],
          _extensionToLanguage: { '.java': 'java' },
          startupTimeout: 120000,
        },
      },
    }),
  )
  const resolved = resolveSettings(dir)
  const projectErrors = resolved.validationErrors.filter(e =>
    e.file.includes(dir),
  )
  assert.equal(
    projectErrors.length,
    0,
    'jdtls without extensionToLanguage is valid',
  )
  assert.deepEqual(resolved.config.disabledTools, ['Bash'])
  console.log('[ok] disabled LSP entry without extensionToLanguage loads')
})

withTempDir(dir => {
  const settingsDir = path.join(dir, '.ai-agent')
  fs.mkdirSync(settingsDir, { recursive: true })
  const filePath = path.join(settingsDir, 'settings.json')
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      disabledTools: ['Bash'],
      lspServers: {
        jdtls: {
          command: 'jdtls',
          _extensionToLanguage: { '.java': 'java' },
        },
      },
    }),
  )
  const extra = path.join(dir, 'extra')
  patchSettings(dir, 'project', {
    permissions: { additionalDirectories: [extra] },
  })
  const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  assert.deepEqual(written.disabledTools, ['Bash'])
  assert.equal(written.lspServers.jdtls.command, 'jdtls')
  assert.deepEqual(written.lspServers.jdtls._extensionToLanguage, {
    '.java': 'java',
  })
  assert.ok(written.permissions.additionalDirectories.includes(extra))
  console.log('[ok] permission patch keeps existing settings JSON')
})

console.log('test-settings-validation: all passed')
