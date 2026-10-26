import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const appDirName = `.baize-reset-e2e-${process.pid}`
const dataRoot = path.join(os.homedir(), appDirName)
const settingsPath = path.join(dataRoot, 'settings.json')
const workspaceFile = path.join(dataRoot, 'workspace', 'delete-me.txt')
const externalProjectFile = path.join(repoRoot, 'note.txt')
const externalProjectContents = fs.readFileSync(externalProjectFile, 'utf-8')
let electronApp

try {
  fs.mkdirSync(path.dirname(workspaceFile), { recursive: true })
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ models: { large: { apiKey: 'e2e-secret' } } }),
  )
  fs.writeFileSync(workspaceFile, 'delete me')

  electronApp = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      AI_AGENT_DIR: appDirName,
      WORKSPACE: path.join(dataRoot, 'workspace'),
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    },
  })

  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window
    .getByTitle('Desktop app')
    .waitFor({ timeout: 45_000 })
    .catch(async err => {
      console.error('[desktop-e2e] url:', window.url())
      console.error(
        '[desktop-e2e] body:',
        (await window.locator('body').innerText()).slice(0, 2_000),
      )
      throw err
    })
  await window.getByTitle('Desktop app').click()
  await window.getByRole('menuitem', { name: 'Restore initial state' }).click()

  const dialog = window.getByRole('dialog', { name: 'Restore initial state' })
  await assert.doesNotReject(() => dialog.waitFor())
  const confirmation = dialog.getByLabel(/Type RESET/)
  const resetButton = dialog.getByRole('button', {
    name: 'Delete data and restore',
  })

  await confirmation.fill('wrong')
  assert.equal(await resetButton.isDisabled(), true)
  await confirmation.fill('RESET')
  assert.equal(await resetButton.isEnabled(), true)

  // Exercise the real reset IPC without leaving a relaunched test app behind.
  await electronApp.evaluate(({ app }) => {
    app.relaunch = () => {}
  })
  const closed = electronApp.waitForEvent('close')
  await resetButton.click().catch(() => {
    // Expected when app.exit closes the renderer before Playwright receives
    // the click response.
  })
  await closed
  electronApp = null

  assert.equal(fs.existsSync(settingsPath), false)
  assert.equal(fs.existsSync(workspaceFile), false)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(
    fs.readFileSync(externalProjectFile, 'utf-8'),
    externalProjectContents,
  )
  console.log('[ok] desktop factory reset UI and IPC')
} finally {
  await electronApp?.close().catch(() => {})
  fs.rmSync(dataRoot, { recursive: true, force: true })
  for (const name of fs.readdirSync(os.homedir())) {
    if (name.startsWith(`${appDirName}.reset-`)) {
      fs.rmSync(path.join(os.homedir(), name), {
        recursive: true,
        force: true,
      })
    }
  }
}
