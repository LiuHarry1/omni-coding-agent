/**
 * Managed (policy) settings — merge + non-writable scope.
 *   conda activate llm_ft && npx tsx src/tests/test-managed-settings.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseWritableScope,
  resetSettingsCache,
  resolveSettings,
} from '../utils/settings/manager.js'
import {
  _resetManagedDirCacheForTest,
  getManagedSettingsPath,
  MANAGED_SETTINGS_DROPIN_DIRNAME,
} from '../utils/managed-path.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-settings-'))
const managedDir = path.join(tmpRoot, 'etc-ai-agent')
const cwd = path.join(tmpRoot, 'project')
fs.mkdirSync(managedDir, { recursive: true })
fs.mkdirSync(path.join(cwd, '.ai-agent'), { recursive: true })

process.env.AI_AGENT_MANAGED_DIR = managedDir
_resetManagedDirCacheForTest()
resetSettingsCache()

try {
  // Project sets model id; managed must win (policy last).
  fs.writeFileSync(
    path.join(cwd, '.ai-agent', 'settings.json'),
    JSON.stringify({
      models: {
        large: {
          model: 'project-model',
          baseURL: 'http://project',
          apiKey: 'p',
        },
      },
      disabledTools: ['web_fetch'],
    }) + '\n',
  )

  fs.writeFileSync(
    getManagedSettingsPath(),
    JSON.stringify({
      models: {
        large: {
          model: 'managed-model',
          baseURL: 'http://managed',
          apiKey: 'm',
        },
      },
      disabledTools: ['Bash'],
    }) + '\n',
  )

  let resolved = resolveSettings(cwd)
  assert(
    resolved.config.models.large.model === 'managed-model',
    `expected managed model, got ${resolved.config.models.large.model}`,
  )
  assert(
    resolved.config.models.large.baseURL === 'http://managed',
    'managed baseURL should win',
  )
  // disabledTools merges (set-union), both present
  const disabledTools = resolved.config.disabledTools ?? []
  assert(
    disabledTools.includes('web_fetch') && disabledTools.includes('Bash'),
    'disabledTools should merge from project + managed',
  )
  assert(
    resolved.sources.some(s => s.scope === 'managed' && s.applied),
    'managed source should be applied',
  )
  console.log('ok: managed overrides project models')

  // Drop-in overrides base managed (alphabetical, later wins).
  const dropDir = path.join(managedDir, MANAGED_SETTINGS_DROPIN_DIRNAME)
  fs.mkdirSync(dropDir, { recursive: true })
  fs.writeFileSync(
    path.join(dropDir, '10-a.json'),
    JSON.stringify({
      models: { large: { model: 'dropin-early' } },
    }) + '\n',
  )
  fs.writeFileSync(
    path.join(dropDir, '20-b.json'),
    JSON.stringify({
      models: { large: { model: 'dropin-late' } },
    }) + '\n',
  )
  resetSettingsCache()
  resolved = resolveSettings(cwd)
  assert(
    resolved.config.models.large.model === 'dropin-late',
    `expected dropin-late, got ${resolved.config.models.large.model}`,
  )
  const managedSources = resolved.sources.filter(s => s.scope === 'managed')
  assert(
    managedSources.length === 1 && managedSources[0]!.applied,
    'managed should appear as a single applied source',
  )
  console.log('ok: managed-settings.d drop-ins merge in order')

  // Not writable (the editable setting sources exclude policy)
  let threw = false
  try {
    parseWritableScope('managed', { ssoMode: false })
  } catch (e) {
    threw = true
    assert(
      (e as Error).message.includes('not writable'),
      'error should mention not writable',
    )
  }
  assert(threw, 'parseWritableScope(managed) must throw')
  console.log('ok: managed scope not writable')

  assert(resolved.managedDir === managedDir, 'managedDir on ResolvedSettings')
  assert(
    resolved.managedPath === getManagedSettingsPath(),
    'managedPath on ResolvedSettings',
  )

  console.log('\nAll managed-settings checks passed.')
} finally {
  delete process.env.AI_AGENT_MANAGED_DIR
  _resetManagedDirCacheForTest()
  resetSettingsCache()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
