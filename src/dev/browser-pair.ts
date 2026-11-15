/**
 * Check that this machine can hand the browser to an agent.
 *
 * There is no pairing step to perform any more: the relay endpoint is a live
 * capability owned by whichever agent process is asking, so it cannot be set
 * up ahead of time from here. What this does is run the same exchange in its
 * own process — start a relay, open the consent tab, wait for the extension —
 * which is what you want when the real thing failed and you need to know
 * whether the extension is installed, has the right id, and can connect.
 *
 * Run: npx tsx src/dev/browser-pair.ts
 */
import {
  openConnectPage,
  resolveExtensionToken,
} from '../browser/relay/open-connect-page.js'
import { startRelayServer } from '../browser/relay/server.js'
import { BRIDGE_EXTENSION_ID } from '../browser/relay/extension-id.js'
import { resolveSettings } from '../utils/settings/manager.js'

async function main(): Promise<void> {
  const config = resolveSettings(process.cwd()).config.browser ?? {}
  const relay = await startRelayServer({ port: config.relayPort })

  console.log('')
  console.log('  Browser extension check')
  console.log('  ───────────────────────')
  console.log(`  Expecting extension  ${BRIDGE_EXTENSION_ID}`)
  console.log(`  Relay listening on   ${relay.wsUrl}`)
  const pairingToken = resolveExtensionToken(config)
  console.log(
    `  Auto-connect token   ${pairingToken ? 'configured' : 'not set (will ask)'}`,
  )
  console.log('')

  try {
    openConnectPage(relay, {
      clientName: 'Baize (browser check)',
      pairingToken,
    })
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    await relay.close()
    return
  }
  console.log(
    pairingToken
      ? '  Opened the connect tab with the token. It should connect on its own.'
      : '  Opened a tab in Chrome asking for access. Approve it there.',
  )
  console.log('')

  try {
    await relay.waitForExtension(120_000)
  } catch {
    console.error('  No connection. Things worth checking:')
    console.error(
      '    - the extension is loaded: chrome://extensions → Developer mode → Load unpacked → chrome-extension/',
    )
    console.error(
      `    - its id reads ${BRIDGE_EXTENSION_ID}; a different one means the manifest "key" is missing`,
    )
    console.error(
      '    - the tab opened in the Chrome profile that has the extension',
    )
    if (pairingToken) {
      console.error(
        '    - the token matches the one in the extension popup (the connect tab says so if not)',
      )
    }
    process.exitCode = 1
    await relay.close()
    return
  }

  console.log(`  Connected: ${relay.peerName() ?? 'unknown browser'}`)
  console.log(
    `  Capabilities: ${[...relay.capabilities()].join(', ') || '(none reported)'}`,
  )
  console.log('')
  if (config.mode !== 'extension' && config.mode !== 'auto') {
    console.log(
      `  Note: browser.mode is "${config.mode ?? 'isolated'}", so the agent still drives its own`,
    )
    console.log(
      '  browser. Set it to "extension" or "auto" in .ai-agent/settings.json.',
    )
    console.log('')
  }
  console.log(
    '  This connection belonged to this command and is now closing. The agent will',
  )
  console.log('  ask for its own when it next needs the browser.')
  console.log('')
  await relay.close()
}

await main()
