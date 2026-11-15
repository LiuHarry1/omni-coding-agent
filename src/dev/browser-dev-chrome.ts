/**
 * Open a Chrome that already has the bridge extension installed and paired.
 *
 * For trying out `browser.mode: "extension"` without touching your everyday
 * Chrome: this uses a dedicated profile under ~/.ai-agent/browser/dev-chrome,
 * so you can sign into whatever the agent needs and keep it separate.
 *
 * Run: npm run browser:dev-chrome
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveSettings } from '../utils/settings/manager.js'
import { getUserAppDir } from '../utils/app-dir.js'
import { launchChromeWithExtension } from './chrome-launcher.js'

const DEBUG_PORT = 9334

async function main() {
  const config = resolveSettings(process.cwd()).config.browser ?? {}
  const userDataDir = path.join(getUserAppDir(), 'browser', 'dev-chrome')
  fs.mkdirSync(userDataDir, { recursive: true })

  // No pairing here: the extension connects to whichever agent process asks
  // for it, and this command only supplies the browser.
  const chrome = await launchChromeWithExtension({
    userDataDir,
    debugPort: DEBUG_PORT,
  })

  console.log('')
  console.log(
    `  Chrome is up with the bridge installed (${chrome.extensionId})`,
  )
  console.log(`  Profile   ${userDataDir}`)
  console.log('')
  if (config.mode !== 'extension' && config.mode !== 'auto') {
    console.log(
      '  Set "browser": { "mode": "extension" } in .ai-agent/settings.json,',
    )
    console.log('  then restart the agent for it to drive this browser.')
    console.log('')
  }
  console.log('  Sign in to whatever the agent needs. Ctrl+C here closes it.')
  console.log('')

  const shutdown = () => {
    void chrome.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  chrome.process.on('exit', () => process.exit(0))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
