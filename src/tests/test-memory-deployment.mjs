import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  assertSafeDesktopDataRoot,
  buildAgentSpawnEnv,
  resolveBundledRipgrepPath,
  resolveDesktopDataRoot,
  resolveDefaultDesktopWorkspace,
} from '../../desktop/agent-launch.mjs'

const home = path.resolve('/test-user-home')
const dataRoot = resolveDesktopDataRoot(home, {})
assert.equal(dataRoot, path.join(home, '.ai-agent'))
const workspace = resolveDefaultDesktopWorkspace({
  packaged: true,
  homeDir: home,
  env: {},
})
assert.equal(
  workspace,
  path.join(home, '.ai-agent', 'workspace'),
  'packaged Electron workspace must live under persistent user HOME',
)

const env = buildAgentSpawnEnv(
  '/read-only/app',
  4567,
  { HOME: home },
  {
    packaged: true,
    workspace,
    appDataDir: dataRoot,
  },
)
assert.equal(env.HOME, home, 'Electron agent child must preserve user HOME')
assert.equal(
  env.WORKSPACE,
  workspace,
  'Electron agent child must use the persistent desktop workspace',
)
assert.equal(
  env.AI_AGENT_DATA_DIR,
  dataRoot,
  'desktop cron/process data must share the factory-reset boundary',
)

const configured = buildAgentSpawnEnv(
  '/read-only/app',
  4567,
  { HOME: home, WORKSPACE: '/explicit-workspace' },
  { packaged: true, workspace },
)
assert.equal(
  configured.WORKSPACE,
  '/explicit-workspace',
  'explicit Electron workspace override must win',
)

const resourcesPath = fs.mkdtempSync(
  path.join(os.tmpdir(), 'desktop-ripgrep-env-'),
)
try {
  const ripgrepDir = path.join(resourcesPath, 'ripgrep')
  fs.mkdirSync(ripgrepDir, { recursive: true })
  fs.writeFileSync(path.join(ripgrepDir, 'rg'), 'mac fixture')
  fs.writeFileSync(path.join(ripgrepDir, 'rg.exe'), 'windows fixture')

  assert.equal(
    resolveBundledRipgrepPath({
      packaged: true,
      resourcesPath,
      platform: 'darwin',
    }),
    path.join(ripgrepDir, 'rg'),
    'macOS packaged desktop must resolve the bundled rg',
  )
  assert.equal(
    resolveBundledRipgrepPath({
      packaged: true,
      resourcesPath,
      platform: 'win32',
    }),
    path.join(ripgrepDir, 'rg.exe'),
    'Windows packaged desktop must resolve the bundled rg.exe',
  )
  assert.equal(
    resolveBundledRipgrepPath({
      packaged: false,
      resourcesPath,
      platform: 'darwin',
    }),
    null,
    'unpackaged desktop must not claim a bundled ripgrep resource',
  )

  const bundledEnv = buildAgentSpawnEnv(
    '/read-only/app',
    4567,
    { HOME: home, BUNDLED_RG_PATH: '/untrusted/inherited/rg' },
    {
      packaged: true,
      resourcesPath,
      workspace,
    },
  )
  assert.equal(
    bundledEnv.BUNDLED_RG_PATH,
    path.join(ripgrepDir, process.platform === 'win32' ? 'rg.exe' : 'rg'),
    'packaged Electron must replace inherited rg paths with its own resource',
  )

  fs.rmSync(ripgrepDir, { recursive: true, force: true })
  const missingEnv = buildAgentSpawnEnv(
    '/read-only/app',
    4567,
    { HOME: home, BUNDLED_RG_PATH: '/untrusted/inherited/rg' },
    {
      packaged: true,
      resourcesPath,
      workspace,
    },
  )
  assert.equal(
    missingEnv.BUNDLED_RG_PATH,
    undefined,
    'packaged Electron must clear inherited rg paths when its resource is missing',
  )
} finally {
  fs.rmSync(resourcesPath, { recursive: true, force: true })
}

const safeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-reset-home-'))
try {
  const safeRoot = path.join(safeHome, '.ai-agent')
  fs.mkdirSync(safeRoot)
  assert.equal(assertSafeDesktopDataRoot(safeRoot, safeHome), safeRoot)
  assert.throws(
    () => assertSafeDesktopDataRoot(safeHome, safeHome),
    /Refusing to reset/,
  )
  assert.throws(
    () =>
      assertSafeDesktopDataRoot(
        path.join(path.dirname(safeHome), '.ai-agent'),
        safeHome,
      ),
    /Refusing to reset/,
  )
} finally {
  fs.rmSync(safeHome, { recursive: true, force: true })
}

console.log('All memory deployment checks passed.')
