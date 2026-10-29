/**
 * End-to-end test of the real MV3 extension in a real Chrome.
 *
 * The relay suite simulates the extension, so this covers the one thing it
 * cannot: that `background.js` actually boots as a service worker, pairs from
 * stored credentials, enforces tab ownership, and forwards CDP through
 * `chrome.debugger`.
 *
 * Runs against a throwaway profile — it never touches the user's Chrome.
 *
 * Run: npx tsx src/tests/test-extension-e2e.ts [--headed]
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createExtensionBackend } from '../browser/backends/extension.js'
import {
  applyFocusConfig,
  flushTabRestore,
} from '../browser/playwright/focus.js'
import { downloadByRef } from '../browser/playwright/downloads.js'
import { startRelayServer } from '../browser/relay/server.js'
import {
  closeBrowser,
  getBrowser,
  getCurrentTabId,
  setBrowserBackendFactory,
} from '../browser/manager.js'
import {
  cdpTool,
  clickTool,
  consoleTool,
  dragTool,
  fileUploadTool,
  fillFormTool,
  getBoundingBoxTool,
  getTextTool,
  handleDialogTool,
  highlightTool,
  hoverTool,
  lockTool,
  mouseClickXYTool,
  navigateTool,
  networkTool,
  pressKeyTool,
  resizeTool,
  screenshotTool,
  scrollTool,
  selectOptionTool,
  snapshotTool,
  tabsTool,
  typeTool,
  waitForTool,
  waitForDownloadTool,
} from '../tools/BrowserTool/BrowserTool.js'
import type {
  AnyTool,
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import { readImageDimensions } from '../utils/image/dimensions.js'
import { startFixtureServer } from './browser-tool-suite.js'
import { launchChromeWithExtension, waitFor } from '../dev/chrome-launcher.js'

const HEADED = process.argv.includes('--headed')

function toolContext(sessionId = 'extension-e2e'): ToolContext {
  return {
    eventBus: {
      emit() {},
      on() {},
      off() {},
    } as unknown as ToolContext['eventBus'],
    wire: { emit() {} } as unknown as ToolContext['wire'],
    cwd: process.cwd(),
    sessionId,
  }
}

async function runForSession(
  def: ToolDefinition,
  args: Record<string, unknown>,
  sessionId: string,
  toolCallId = `call-${Math.random().toString(36).slice(2, 8)}`,
  abortSignal?: AbortSignal,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  const tool = def.create(process.cwd(), toolContext(sessionId)) as AnyTool & {
    execute: (
      a: unknown,
      o: { toolCallId: string; abortSignal?: AbortSignal },
    ) => Promise<DualChannelToolResult<Record<string, unknown>> | string>
  }
  return tool.execute(args, { toolCallId, abortSignal })
}

async function run(
  def: ToolDefinition,
  args: Record<string, unknown>,
  toolCallId = `call-${Math.random().toString(36).slice(2, 8)}`,
  abortSignal?: AbortSignal,
): Promise<DualChannelToolResult<Record<string, unknown>> | string> {
  return runForSession(def, args, 'extension-e2e', toolCallId, abortSignal)
}

function expectData(
  result: DualChannelToolResult<Record<string, unknown>> | string,
): Record<string, unknown> {
  assert.ok(typeof result !== 'string', `expected success, got: ${result}`)
  return result.data
}

function yamlFromObserve(out: Record<string, unknown>): string {
  const artifact = out.snapshotArtifactPath
  if (typeof artifact === 'string' && artifact && fs.existsSync(artifact)) {
    return fs.readFileSync(artifact, 'utf8')
  }
  return String(out.snapshot ?? '')
}

function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find(l => l.includes(`${role} "${name}"`) && l.includes('[ref='))
  assert.ok(line, `no ref for ${role} "${name}" in:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

function refNear(snapshot: string, text: string): string {
  const line = snapshot
    .split('\n')
    .find(candidate => candidate.includes(text) && candidate.includes('[ref='))
  assert.ok(line, `no ref near "${text}" in:\n${snapshot}`)
  return /\[ref=([^\]]+)\]/.exec(line)![1]
}

function screenshotPoint(
  out: Record<string, unknown>,
  viewportX: number,
  viewportY: number,
): { x: number; y: number } {
  assert.equal(typeof out.screenshotBase64, 'string')
  const dimensions = readImageDimensions(
    Buffer.from(out.screenshotBase64 as string, 'base64'),
  )
  assert.ok(dimensions)
  return {
    x: Math.round((viewportX * dimensions.width) / 1280),
    y: Math.round((viewportY * dimensions.height) / 800),
  }
}

async function main() {
  const fixture = await startFixtureServer()
  const relay = await startRelayServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ext-e2e-'))

  // Goes through the extension's own consent page and presses its Allow
  // button, so this covers the path a user actually walks.
  const chrome = await launchChromeWithExtension({
    userDataDir: profile,
    headless: !HEADED,
    pair: { connectUrl: relay.connectUrl('Baize e2e') },
  })
  let workerSession = chrome.workerSession
  const chromeDownloadDir = path.join(profile, 'Downloads')
  fs.mkdirSync(chromeDownloadDir, { recursive: true })
  await chrome.cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: chromeDownloadDir,
    eventsEnabled: true,
  })
  console.log(`ok [e2e] extension loaded into chrome (${chrome.extensionId})`)

  /** Real tabs in the browser, ignoring extension pages. */
  async function countUserPages(): Promise<number> {
    const { targetInfos } = await chrome.cdp.send<{
      targetInfos: Array<{ type: string; url: string }>
    }>('Target.getTargets')
    return targetInfos.filter(
      t => t.type === 'page' && !t.url.startsWith('chrome-extension://'),
    ).length
  }

  async function countConnectPages(): Promise<number> {
    const { targetInfos } = await chrome.cdp.send<{
      targetInfos: Array<{ type: string; url: string }>
    }>('Target.getTargets')
    return targetInfos.filter(
      t => t.type === 'page' && t.url.includes('/connect.html'),
    ).length
  }

  try {
    await waitFor('extension to connect', () => relay.isConnected())
    assert.match(String(relay.peerName()), /Chrome/)
    assert.ok(
      relay.capabilities().has('chrome.debugger.sendCommand'),
      'the real extension must report its capabilities in the handshake',
    )
    assert.ok(
      relay.capabilities().has('targets.lifecycle'),
      'the real extension must report target lifecycle support',
    )
    console.log('ok [e2e] connected by approving the extension consent page')

    // ── drive the real extension through the tool layer ──
    const sharedE2eBackend = createExtensionBackend({ relay })
    setBrowserBackendFactory(() => sharedE2eBackend, { scope: 'shared' })

    const nav = expectData(await run(navigateTool, { url: fixture.url }))
    assert.equal(nav.title, 'Verify Loop Fixture')
    const snapshot = String(nav.snapshot)
    assert.ok(snapshot.includes('heading "Dashboard"'), snapshot)
    console.log('ok [e2e] navigate + snapshot through chrome.debugger')

    const counter = refFor(snapshot, 'button', 'Clicked 0 times')
    const clicked = expectData(await run(clickTool, { ref: counter }))
    assert.ok(String(clicked.snapshot).includes('Clicked 1 times'))
    console.log('ok [e2e] click through chrome.debugger')

    const secondSessionId = 'extension-e2e-second-session'
    let secondSessionTabId: string | undefined
    try {
      const firstSessionTabId = getCurrentTabId('extension-e2e')
      assert.ok(firstSessionTabId)
      expectData(
        await runForSession(
          tabsTool,
          { action: 'new', url: `${fixture.url}other` },
          secondSessionId,
        ),
      )
      secondSessionTabId = getCurrentTabId(secondSessionId)
      assert.ok(secondSessionTabId)
      assert.notEqual(secondSessionTabId, firstSessionTabId)
      assert.equal(
        await getBrowser(process.cwd(), secondSessionId),
        await getBrowser(process.cwd(), 'extension-e2e'),
        'both sessions must exercise the same extension backend instance',
      )

      const firstSessionSnapshot = String(
        expectData(await run(snapshotTool, {})).snapshot,
      )
      const firstSessionCounter = refFor(
        firstSessionSnapshot,
        'button',
        'Clicked 1 times',
      )
      const secondSessionSnapshot = String(
        expectData(await runForSession(snapshotTool, {}, secondSessionId))
          .snapshot,
      )
      assert.match(secondSessionSnapshot, /heading "Other page"/)
      assert.doesNotMatch(firstSessionSnapshot, /heading "Other page"/)

      const foreignRef = await runForSession(
        clickTool,
        { ref: firstSessionCounter },
        secondSessionId,
      )
      assert.equal(typeof foreignRef, 'string')
      assert.match(String(foreignRef), /not found|stale|snapshot/i)

      expectData(await run(lockTool, { action: 'unlock' }))
      const secondSessionDashboard = expectData(
        await runForSession(
          navigateTool,
          { url: fixture.url },
          secondSessionId,
        ),
      )
      const secondSessionCounter = refFor(
        String(secondSessionDashboard.snapshot),
        'button',
        'Clicked 0 times',
      )
      const secondSessionClick = expectData(
        await runForSession(
          clickTool,
          { ref: secondSessionCounter },
          secondSessionId,
        ),
      )
      assert.match(String(secondSessionClick.snapshot), /Clicked 1 times/)
      const lockedFirstSessionClick = await run(clickTool, {
        ref: firstSessionCounter,
      })
      assert.equal(typeof lockedFirstSessionClick, 'string')
      assert.match(String(lockedFirstSessionClick), /user.*control/i)

      assert.equal(getCurrentTabId('extension-e2e'), firstSessionTabId)
      assert.equal(getCurrentTabId(secondSessionId), secondSessionTabId)
      console.log(
        'ok [e2e] shared extension isolates current tabs, refs and locks by session',
      )
    } finally {
      await run(lockTool, { action: 'lock' })
      if (secondSessionTabId) {
        await runForSession(
          tabsTool,
          { action: 'close', tabId: secondSessionTabId },
          secondSessionId,
        )
      }
      await closeBrowser(secondSessionId)
    }

    const shot = expectData(await run(screenshotTool, {}, 'e2e-shot'))
    assert.ok(fs.existsSync(String(shot.screenshotPath)))
    assert.ok(fs.statSync(String(shot.screenshotPath)).size > 1000)
    console.log('ok [e2e] screenshot through chrome.debugger')

    if (HEADED) {
      const { targetInfos } = await chrome.cdp.send<{
        targetInfos: Array<{ targetId: string; type: string; url: string }>
      }>('Target.getTargets')
      const ownedPage = targetInfos.find(
        target => target.type === 'page' && target.url.startsWith(fixture.url),
      )
      assert.ok(ownedPage)
      const window = await chrome.cdp.send<{
        windowId: number
        bounds: {
          left?: number
          top?: number
          width?: number
          height?: number
          windowState?: string
        }
      }>('Browser.getWindowForTarget', {
        targetId: ownedPage.targetId,
      })
      try {
        await chrome.cdp.send('Browser.setWindowBounds', {
          windowId: window.windowId,
          bounds: { windowState: 'minimized' },
        })
        await new Promise(resolve => setTimeout(resolve, 2_000))
        const started = Date.now()
        const minimizedScreenshot = await run(screenshotTool, {})
        if (typeof minimizedScreenshot === 'string') {
          assert.match(minimizedScreenshot, /Chrome is not rendering this tab/)
        } else {
          assert.ok(minimizedScreenshot.data.screenshotPath)
        }
        assert.ok(
          Date.now() - started < 5_000,
          'a minimized window must complete or fail before the screenshot timeout',
        )
      } finally {
        await chrome.cdp.send('Browser.setWindowBounds', {
          windowId: window.windowId,
          bounds: { windowState: 'normal' },
        })
        const { left, top, width, height } = window.bounds
        if (
          left !== undefined &&
          top !== undefined &&
          width !== undefined &&
          height !== undefined
        ) {
          await chrome.cdp.send('Browser.setWindowBounds', {
            windowId: window.windowId,
            bounds: { left, top, width, height },
          })
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      expectData(await run(snapshotTool, {}))
      console.log(
        'ok [e2e] minimized Chrome completes or fails visual tools quickly',
      )
    }

    const stale = await run(clickTool, { ref: counter })
    assert.ok(
      typeof stale === 'string' &&
        stale.includes(`Element not found: ${counter}`) &&
        stale.includes('Recovery action: browser_snapshot'),
      'stale refs must behave the same as on the isolated backend',
    )
    console.log('ok [e2e] stale ref detection matches the isolated backend')

    const interactiveOnly = expectData(
      await run(snapshotTool, { interactive: true }),
    )
    assert.match(String(interactiveOnly.snapshot), /button "Clicked 1 times"/)
    assert.doesNotMatch(String(interactiveOnly.snapshot), /heading "Dashboard"/)

    const controls = String(expectData(await run(snapshotTool, {})).snapshot)
    const typed = expectData(
      await run(typeTool, {
        ref: refFor(controls, 'textbox', 'Email address'),
        text: 'extension@example.com',
        slowly: true,
      }),
    )
    assert.match(String(typed.message), /extension@example\.com/)
    const afterType = String(expectData(await run(snapshotTool, {})).snapshot)
    const selected = expectData(
      await run(selectOptionTool, {
        ref: refFor(afterType, 'combobox', 'Environment'),
        values: ['Production'],
      }),
    )
    assert.match(String(selected.message), /Production/)
    const afterSelect = String(expectData(await run(snapshotTool, {})).snapshot)
    const hovered = expectData(
      await run(hoverTool, {
        ref: refFor(afterSelect, 'button', 'Hover me'),
      }),
    )
    assert.match(String(hovered.snapshot), /Hovered/)
    const pressed = expectData(await run(pressKeyTool, { key: 'Escape' }))
    assert.match(String(pressed.snapshot), /Last key: Escape/)

    expectData(await run(resizeTool, { width: 900, height: 700 }))
    const resizedSnapshot = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const environmentRef = refFor(resizedSnapshot, 'combobox', 'Environment')
    const bounds = expectData(
      await run(getBoundingBoxTool, { ref: environmentRef }),
    ).value as { width: number; height: number }
    assert.ok(bounds.width > 0 && bounds.height > 0)
    expectData(
      await run(highlightTool, {
        ref: environmentRef,
        durationMs: 500,
      }),
    )
    const viewport = expectData(
      await run(cdpTool, {
        method: 'Runtime.evaluate',
        params: {
          expression: '({ width: innerWidth, height: innerHeight })',
          returnByValue: true,
        },
      }),
    )
    assert.deepEqual(
      (
        viewport.value as {
          result?: { value?: { width: number; height: number } }
        }
      ).result?.value,
      { width: 900, height: 700 },
    )
    expectData(await run(resizeTool, { width: 1280, height: 800 }))
    console.log(
      'ok [e2e] snapshot, form, keyboard, visual and CDP tools use real MV3',
    )

    const diagnostics = expectData(
      await run(navigateTool, { url: `${fixture.url}diagnostics` }),
    )
    expectData(
      await run(clickTool, {
        ref: refFor(
          String(diagnostics.snapshot),
          'button',
          'Emit console levels',
        ),
      }),
    )
    const errors = expectData(await run(consoleTool, { level: 'error' }))
      .consoleErrors as Array<{ text: string }>
    assert.ok(errors.some(entry => entry.text.includes('diagnostics error')))
    const diagnosticsFresh = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    expectData(
      await run(clickTool, {
        ref: refFor(diagnosticsFresh, 'button', 'Make requests'),
      }),
    )
    const requests = expectData(await run(networkTool, {})).network as Array<{
      url: string
      status: number
    }>
    assert.ok(
      requests.some(
        entry => entry.url.includes('/api/boom') && entry.status === 500,
      ),
    )
    expectData(
      await run(cdpTool, {
        method: 'Runtime.evaluate',
        params: {
          expression: `(async () => {
            for (let i = 0; i < 600; i += 1) {
              console.log('burst-log-' + i + (i === 599 ? '-' + 'x'.repeat(20000) : ''));
            }
            await Promise.all(Array.from({ length: 120 }, (_, i) =>
              fetch('/api/ok?burst=' + i)
            ));
            return 'burst complete';
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
      }),
    )
    const burstConsole = expectData(
      await run(consoleTool, { level: 'log', limit: 25 }),
    ).consoleErrors as Array<{ text: string }>
    assert.equal(burstConsole.length, 25)
    assert.ok(burstConsole.some(entry => entry.text.includes('burst-log-599')))
    const burstNetwork = expectData(
      await run(networkTool, { urlContains: 'burst=', limit: 30 }),
    )
    assert.equal((burstNetwork.network as unknown[]).length, 30)
    assert.ok(Number(burstNetwork.networkTotal) >= 30)

    const cdpCloseStartedAt = Date.now()
    const cdpDuringClose = run(
      cdpTool,
      {
        method: 'Runtime.evaluate',
        params: {
          expression:
            'new Promise(resolve => setTimeout(() => resolve("late"), 20000))',
          awaitPromise: true,
          returnByValue: true,
        },
      },
      'e2e-cdp-close',
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    const activeBackend = await getBrowser(process.cwd(), 'extension-e2e')
    await activeBackend.closeTab(getCurrentTabId('extension-e2e')!)
    const interruptedCdp = await cdpDuringClose
    assert.equal(typeof interruptedCdp, 'string')
    assert.match(
      String(interruptedCdp),
      /closed|detached|target|session|interrupted|disconnected/i,
    )
    assert.ok(Date.now() - cdpCloseStartedAt < 5_000)
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] high-throughput diagnostics stay bounded and CDP tab-close races recover',
    )

    const beforeLock = String(expectData(await run(snapshotTool, {})).snapshot)
    expectData(await run(lockTool, { action: 'unlock' }))
    const blockedClick = await run(clickTool, {
      ref: refFor(beforeLock, 'button', 'Clicked 0 times'),
    })
    assert.equal(typeof blockedClick, 'string')
    assert.match(String(blockedClick), /user.*control|control.*user/i)
    expectData(await run(tabsTool, { action: 'list' }))
    expectData(await run(lockTool, { action: 'lock' }))

    const beforeRestore = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const userPage = await chrome.cdp.send<{ targetId: string }>(
      'Target.createTarget',
      { url: `${fixture.url}other?user-tab=1` },
    )
    await chrome.cdp.send('Target.activateTarget', {
      targetId: userPage.targetId,
    })
    applyFocusConfig({ restoreTabAfterInput: true })
    try {
      expectData(
        await run(clickTool, {
          ref: refFor(beforeRestore, 'button', 'Clicked 0 times'),
        }),
      )
      await flushTabRestore()
      const activeAfterInput = await chrome.cdp.send<{
        result: { value: Array<{ url: string }> }
      }>(
        'Runtime.evaluate',
        {
          expression:
            'chrome.tabs.query({ active: true, currentWindow: true })',
          awaitPromise: true,
          returnByValue: true,
        },
        workerSession,
      )
      assert.match(
        String(activeAfterInput.result.value[0]?.url),
        /\/other\?user-tab=1$/,
      )
    } finally {
      applyFocusConfig({ restoreTabAfterInput: false })
      await chrome.cdp.send('Target.closeTarget', {
        targetId: userPage.targetId,
      })
    }

    const formPage = expectData(
      await run(navigateTool, { url: `${fixture.url}form` }),
    )
    const formSnapshot = String(formPage.snapshot)
    const formFilled = expectData(
      await run(fillFormTool, {
        fields: [
          {
            ref: refFor(formSnapshot, 'textbox', 'Merchant'),
            value: 'MV3 Hotel',
          },
          {
            ref: refFor(formSnapshot, 'checkbox', 'Billable'),
            value: 'true',
            kind: 'checkbox',
          },
        ],
      }),
    )
    assert.match(String(formFilled.message), /Filled 2\/2 fields/)

    const widgets = expectData(
      await run(navigateTool, { url: `${fixture.url}widgets` }),
    )
    const widgetSnapshot = String(widgets.snapshot)
    const customSelect = await run(selectOptionTool, {
      ref: refNear(widgetSnapshot, 'Fruit'),
      values: ['Banana'],
    })
    assert.equal(typeof customSelect, 'string')
    assert.match(String(customSelect), /only supports a native <select>/)
    expectData(
      await run(clickTool, {
        ref: refNear(widgetSnapshot, 'Fruit'),
      }),
    )
    const openedListbox = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const banana = expectData(
      await run(clickTool, {
        ref: refFor(openedListbox, 'option', 'Banana'),
      }),
    )
    assert.match(String(banana.snapshot), /Banana/)

    const unarmedConfirm = await run(clickTool, {
      ref: refFor(
        String(expectData(await run(snapshotTool, {})).snapshot),
        'button',
        'Confirm me',
      ),
    })
    assert.equal(typeof unarmedConfirm, 'string')
    assert.match(String(unarmedConfirm), /handle_dialog|not armed/i)
    assert.match(
      String(unarmedConfirm),
      /Recovery action: browser_handle_dialog with accept: true/,
    )

    expectData(await run(handleDialogTool, { accept: false }))
    const dismissed = expectData(
      await run(clickTool, {
        ref: refFor(
          String(expectData(await run(snapshotTool, {})).snapshot),
          'button',
          'Confirm me',
        ),
      }),
    )
    assert.match(String(dismissed.snapshot), /dismissed/)
    const afterConfirm = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    expectData(
      await run(handleDialogTool, {
        accept: true,
        promptText: 'MV3-42',
      }),
    )
    const prompted = expectData(
      await run(clickTool, {
        ref: refFor(afterConfirm, 'button', 'Prompt me'),
      }),
    )
    assert.match(String(prompted.snapshot), /prompt:MV3-42/)
    const afterPrompt = String(expectData(await run(snapshotTool, {})).snapshot)
    expectData(await run(handleDialogTool, { accept: true }))
    const alerted = expectData(
      await run(clickTool, {
        ref: refFor(afterPrompt, 'button', 'Alert me'),
      }),
    )
    assert.match(String(alerted.snapshot), /alert closed/)
    const uploadFile = path.join(profile, 'mv3-upload.txt')
    const secondUploadFile = path.join(profile, 'mv3-upload-second.txt')
    fs.writeFileSync(uploadFile, 'extension upload')
    fs.writeFileSync(secondUploadFile, 'second extension upload')
    const widgetFresh = String(expectData(await run(snapshotTool, {})).snapshot)
    const uploaded = expectData(
      await run(fileUploadTool, {
        ref: refFor(widgetFresh, 'button', 'Receipt upload'),
        paths: [uploadFile, secondUploadFile],
      }),
    )
    assert.match(String(uploaded.snapshot), /mv3-upload\.txt/)
    assert.match(String(uploaded.snapshot), /mv3-upload-second\.txt/)
    const missingUpload = await run(fileUploadTool, {
      paths: [path.join(profile, 'no-such-extension-upload.txt')],
    })
    assert.equal(typeof missingUpload, 'string')
    assert.match(String(missingUpload), /File not found/i)
    assert.match(String(missingUpload), /Recovery action:/)

    const hiddenUploadPage = expectData(
      await run(navigateTool, { url: `${fixture.url}hidden-upload` }),
    )
    const hiddenUploaded = expectData(
      await run(fileUploadTool, {
        ref: refFor(
          String(hiddenUploadPage.snapshot),
          'button',
          'Choose files',
        ),
        paths: [uploadFile],
      }),
    )
    assert.match(String(hiddenUploaded.snapshot), /mv3-upload\.txt/)
    const hiddenUploadState = expectData(
      await run(cdpTool, {
        method: 'Runtime.evaluate',
        params: {
          expression:
            '({ widget: document.querySelector("#widget-state").textContent, global: document.querySelector("#global-state").textContent })',
          returnByValue: true,
        },
      }),
    )
    assert.deepEqual(
      (
        hiddenUploadState.value as {
          result?: { value?: { widget?: string; global?: string } }
        }
      ).result?.value,
      { widget: 'mv3-upload.txt', global: 'none' },
    )

    expectData(await run(navigateTool, { url: `${fixture.url}coordinate` }))
    const { targetInfos: coordinateTargets } = await chrome.cdp.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }>('Target.getTargets')
    const coordinateTarget = coordinateTargets.find(
      target =>
        target.type === 'page' &&
        target.url.startsWith(`${fixture.url}coordinate`),
    )
    assert.ok(coordinateTarget)
    const coordinateSession = (
      await chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: coordinateTarget.targetId,
        flatten: true,
      })
    ).sessionId
    try {
      await chrome.cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: 1280,
          height: 800,
          deviceScaleFactor: 2,
          mobile: false,
        },
        coordinateSession,
      )
      const emulatedDpr = expectData(
        await run(cdpTool, {
          method: 'Runtime.evaluate',
          params: {
            expression: 'devicePixelRatio',
            returnByValue: true,
          },
        }),
      )
      assert.equal(
        (emulatedDpr.value as { result?: { value?: number } }).result?.value,
        2,
      )
      const noScreenshotClick = await run(mouseClickXYTool, {
        x: 100,
        y: 120,
      })
      assert.equal(typeof noScreenshotClick, 'string')
      assert.match(String(noScreenshotClick), /fresh viewport screenshot/i)
      const invalidatedScreenshot = expectData(await run(screenshotTool, {}))
      expectData(await run(snapshotTool, {}))
      const invalidatedClick = await run(
        mouseClickXYTool,
        screenshotPoint(invalidatedScreenshot, 100, 120),
      )
      assert.equal(typeof invalidatedClick, 'string')
      assert.match(String(invalidatedClick), /fresh viewport screenshot/i)
      const coordinateScreenshot = expectData(await run(screenshotTool, {}))
      const dimensions = readImageDimensions(
        Buffer.from(String(coordinateScreenshot.screenshotBase64), 'base64'),
      )
      assert.ok(dimensions)
      assert.equal(dimensions.width, 1280)
      assert.equal(dimensions.height, 800)
      const coordinateClicked = expectData(
        await run(
          mouseClickXYTool,
          screenshotPoint(coordinateScreenshot, 100, 120),
        ),
      )
      assert.match(String(coordinateClicked.snapshot), /Canvas clicked/)
    } finally {
      await chrome.cdp
        .send('Emulation.clearDeviceMetricsOverride', {}, coordinateSession)
        .catch(() => {})
      await chrome.cdp
        .send('Target.detachFromTarget', { sessionId: coordinateSession })
        .catch(() => {})
    }
    const interactions = expectData(
      await run(navigateTool, { url: `${fixture.url}interactions` }),
    )
    const wrongElementHint = await run(clickTool, {
      ref: refFor(String(interactions.snapshot), 'button', 'Click matrix'),
      element: 'Delete Alice',
    })
    assert.equal(typeof wrongElementHint, 'string')
    assert.match(String(wrongElementHint), /does not match/i)
    const rightClicked = expectData(
      await run(clickTool, {
        ref: refFor(String(interactions.snapshot), 'button', 'Click matrix'),
        button: 'right',
      }),
    )
    assert.match(String(rightClicked.snapshot), /context button=2/)
    const interactionFresh = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const offsetClicked = expectData(
      await run(clickTool, {
        ref: refFor(interactionFresh, 'button', 'Click matrix'),
        modifiers: ['Alt', 'Shift'],
        offsetX: 12,
        offsetY: 15,
      }),
    )
    assert.match(
      String(offsetClicked.snapshot),
      /shift=true alt=true offset=12,15/,
    )
    const beforeDrag = String(expectData(await run(snapshotTool, {})).snapshot)
    const dragged = expectData(
      await run(dragTool, {
        startRef: refFor(beforeDrag, 'button', 'Drag source'),
        endRef: refFor(beforeDrag, 'button', 'Drop target'),
      }),
    )
    assert.match(String(dragged.snapshot), /dropped/)
    const scrollMatrix = expectData(
      await run(navigateTool, { url: `${fixture.url}scroll-matrix` }),
    )
    const containerTarget = refFor(
      String(scrollMatrix.snapshot),
      'button',
      'Container target',
    )
    expectData(
      await run(scrollTool, {
        ref: containerTarget,
        deltaY: 600,
        deltaX: 240,
      }),
    )
    const containerPosition = expectData(
      await run(cdpTool, {
        method: 'Runtime.evaluate',
        params: {
          expression:
            '({ top: document.querySelector("#scroller").scrollTop, left: document.querySelector("#scroller").scrollLeft, page: scrollY })',
          returnByValue: true,
        },
      }),
    )
    const scrolled = (
      containerPosition.value as {
        result?: { value?: { top?: number; left?: number; page?: number } }
      }
    ).result?.value
    assert.ok((scrolled?.top ?? 0) > 0, JSON.stringify(scrolled))
    assert.ok((scrolled?.left ?? 0) > 0, JSON.stringify(scrolled))
    assert.equal(scrolled?.page, 0)
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] lock, tab restore, form, dialog, upload, coordinates, click variants, drag and nested scroll use real MV3',
    )

    expectData(await run(navigateTool, { url: `${fixture.url}text-regions` }))
    const articleText = expectData(await run(getTextTool, {}))
    assert.equal(String(articleText.snapshot).trim(), 'Primary article text')
    assert.match(String(articleText.message), /article/)
    expectData(await run(navigateTool, { url: `${fixture.url}overflow` }))
    const boundedText = expectData(
      await run(getTextTool, { selector: '#feed', maxChars: 120 }),
    )
    assert.equal(String(boundedText.snapshot).length, 120)
    assert.equal(boundedText.snapshotTruncated, true)
    const missingText = await run(getTextTool, {
      selector: '#does-not-exist',
    })
    assert.equal(typeof missingText, 'string')
    assert.match(String(missingText), /Recovery action: browser_snapshot/)
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] get_text selects article content, bounds output and recovers from missing selectors',
    )

    const lazyDialogPage = expectData(
      await run(navigateTool, { url: `${fixture.url}dialog-lazy` }),
    )
    const lazyDialogOpened = expectData(
      await run(clickTool, {
        ref: refNear(yamlFromObserve(lazyDialogPage), '有新消息'),
      }),
    )
    const lazyDialogSnapshot = yamlFromObserve(lazyDialogOpened)
    assert.match(lazyDialogSnapshot, /8月/)
    assert.match(lazyDialogSnapshot, /蒋先生/)
    const scopedDialog = expectData(
      await run(snapshotTool, { selector: '[role=dialog]' }),
    )
    assert.match(String(scopedDialog.snapshot), /蒋先生/)

    const nestedDialogPage = expectData(
      await run(navigateTool, { url: `${fixture.url}dialog-nested` }),
    )
    const conversationList = expectData(
      await run(clickTool, {
        ref: refNear(yamlFromObserve(nestedDialogPage), 'Open inbox'),
      }),
    )
    const thread = expectData(
      await run(clickTool, {
        ref: refNear(yamlFromObserve(conversationList), 'Ada Reed'),
      }),
    )
    const threadSnapshot = yamlFromObserve(thread)
    assert.match(threadSnapshot, /Type a message/)
    assert.match(threadSnapshot, /button "Send"/)
    assert.match(threadSnapshot, /Conversations/)

    const pdfPreview = expectData(
      await run(navigateTool, { url: `${fixture.url}pdf-preview` }),
    )
    assert.match(
      yamlFromObserve(pdfPreview) || String(pdfPreview.message),
      /button "Save"|Embedded frames omitted|Full-page snapshot timed out/,
    )

    const errorModalPage = expectData(
      await run(navigateTool, { url: `${fixture.url}error-modal` }),
    )
    const errorModal = expectData(
      await run(clickTool, {
        ref: refFor(String(errorModalPage.snapshot), 'button', 'Save Expense'),
      }),
    )
    assert.match(String(errorModal.snapshot), /alertdialog/)
    assert.match(String(errorModal.snapshot), /button "Yes"/)
    assert.match(String(errorModal.snapshot), /make corrections/)

    const staleModal = expectData(
      await run(navigateTool, { url: `${fixture.url}stale-modal` }),
    )
    assert.match(String(staleModal.snapshot), /Continue Expense/)
    assert.doesNotMatch(String(staleModal.snapshot), /Please Confirm/)

    const coveredPage = expectData(
      await run(navigateTool, { url: fixture.url }),
    )
    const coveredClick = await run(clickTool, {
      ref: refFor(String(coveredPage.snapshot), 'button', 'Confirm order'),
    })
    assert.equal(typeof coveredClick, 'string')
    assert.match(
      String(coveredClick),
      /modal|intercept|timeout|not visible|obscur|interactable|covered/i,
    )
    console.log(
      'ok [e2e] lazy/nested dialogs, hung iframe snapshots and modal interception use real MV3',
    )

    const waitPage = expectData(
      await run(navigateTool, { url: `${fixture.url}wait-text?e2e=1` }),
    )
    expectData(
      await run(clickTool, {
        ref: refFor(String(waitPage.snapshot), 'button', 'Reveal'),
      }),
    )
    const textGone = expectData(
      await run(waitForTool, { textGone: 'Loading now' }),
    )
    assert.doesNotMatch(String(textGone.snapshot), /Loading now/)
    const selectorVisible = expectData(
      await run(waitForTool, { selector: '#later' }),
    )
    assert.match(String(selectorVisible.snapshot), /Selector appeared/)
    expectData(
      await run(clickTool, {
        ref: refFor(
          String(selectorVisible.snapshot),
          'button',
          'Navigate later',
        ),
      }),
    )
    const urlChanged = expectData(
      await run(waitForTool, { url: '**/other?waited=url' }),
    )
    assert.match(String(urlChanged.url), /\/other\?waited=url$/)
    const waitTimeoutStartedAt = Date.now()
    const waitTimeout = await run(waitForTool, {
      text: 'This text never appears in the MV3 fixture',
      timeoutMs: 150,
    })
    assert.equal(typeof waitTimeout, 'string')
    assert.match(String(waitTimeout), /timed out|timeout/i)
    assert.ok(
      Date.now() - waitTimeoutStartedAt < 2_000,
      'real extension must honor the tool-level wait timeout',
    )

    const spaStart = expectData(
      await run(navigateTool, { url: `${fixture.url}spa?route=one` }),
    )
    const oldSpaRef = refFor(String(spaStart.snapshot), 'button', 'Go SPA two')
    const spaChanged = expectData(await run(clickTool, { ref: oldSpaRef }))
    assert.match(String(spaChanged.url), /\/spa\?route=two$/)
    const staleSpaClick = await run(clickTool, { ref: oldSpaRef })
    assert.equal(typeof staleSpaClick, 'string')
    assert.match(String(staleSpaClick), /stale|not found|snapshot/i)

    const sameOriginRedirect = expectData(
      await run(navigateTool, { url: `${fixture.url}redirect/start` }),
    )
    assert.match(
      String(sameOriginRedirect.url),
      /\/other\?redirect=same-origin$/,
    )
    assert.equal(sameOriginRedirect.title, 'Other')
    const crossOriginRedirect = expectData(
      await run(navigateTool, {
        url: `${fixture.url}redirect/cross-origin`,
      }),
    )
    assert.match(
      String(crossOriginRedirect.url),
      /^http:\/\/localhost:\d+\/other\?redirect=cross-origin$/,
    )
    assert.equal(crossOriginRedirect.title, 'Other')
    const redirectLoop = await run(navigateTool, {
      url: `${fixture.url}redirect/loop-a`,
    })
    assert.equal(typeof redirectLoop, 'string')
    assert.match(String(redirectLoop), /redirect|ERR_TOO_MANY/i)

    const beforeUnloadPage = expectData(
      await run(navigateTool, { url: `${fixture.url}beforeunload` }),
    )
    expectData(
      await run(clickTool, {
        ref: refFor(
          String(beforeUnloadPage.snapshot),
          'button',
          'Arm before unload',
        ),
      }),
    )
    const afterBeforeUnload = expectData(
      await run(navigateTool, {
        url: `${fixture.url}other?after=beforeunload`,
      }),
    )
    assert.match(String(afterBeforeUnload.url), /after=beforeunload/)

    const tlsFailure = await run(navigateTool, {
      url: fixture.url.replace('http://', 'https://'),
    })
    assert.equal(typeof tlsFailure, 'string')
    assert.match(String(tlsFailure), /SSL|certificate|ERR_/i)
    expectData(await run(navigateTool, { url: fixture.url }))

    const dnsFailure = await run(navigateTool, {
      url: 'http://browser-agent-does-not-exist.invalid/',
    })
    assert.equal(typeof dnsFailure, 'string')
    assert.match(String(dnsFailure), /NAME_NOT_RESOLVED|DNS|ERR_/i)
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] wait, SPA/history, redirects and navigation failures recover in real MV3',
    )

    // ── the consent model, on the real extension ─────────
    assert.ok(
      (await countUserPages()) >= 2,
      'expected the original about:blank plus the agent tab',
    )

    const backend = await createExtensionBackend({ relay })
    const visible = await backend.listTabs()
    assert.equal(
      visible.length,
      1,
      `agent should only see the tab it opened, saw: ${JSON.stringify(visible)}`,
    )
    console.log("ok [e2e] agent cannot enumerate the user's other tabs")

    // Filtering the list is not enough — driving an unowned tab must be refused
    // too. Chrome tab ids are small integers, so probe a neighbouring one.
    const ownedId = Number(visible[0].targetId)
    const denied = await backend
      .send(String(ownedId === 1 ? 2 : 1), 'Runtime.evaluate', {
        expression: '1',
      })
      .then(() => 'allowed')
      .catch((err: Error) => err.message)
    assert.match(
      String(denied),
      /not shared with the agent/,
      `driving an unshared tab must be refused, got: ${denied}`,
    )
    console.log('ok [e2e] driving an unshared tab is refused')

    const popupPagesBefore = await countUserPages()
    const beforePopup = String(expectData(await run(snapshotTool, {})).snapshot)
    expectData(
      await run(clickTool, {
        ref: refFor(beforePopup, 'link', 'Open popup'),
      }),
    )
    await waitFor(
      'popup opened by an owned tab to become owned',
      async () => (await backend.listTabs()).length === 2,
    )
    const popupTabs = await backend.listTabs()
    const inheritedPopup = popupTabs.find(tab => tab.url.includes('popup=1'))
    assert.ok(
      inheritedPopup,
      `owned popup was not listed: ${JSON.stringify(popupTabs)}`,
    )
    assert.equal(await countUserPages(), popupPagesBefore + 1)
    expectData(
      await run(tabsTool, {
        action: 'close',
        tabId: inheritedPopup.targetId,
      }),
    )
    assert.equal(await countUserPages(), popupPagesBefore)
    const beforeNoopenerPopup = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    expectData(
      await run(clickTool, {
        ref: refFor(beforeNoopenerPopup, 'link', 'Open noopener popup'),
      }),
    )
    await waitFor(
      'noopener popup opened by an owned tab to become owned',
      async () => (await backend.listTabs()).length === 2,
    )
    const noopenerTabs = await backend.listTabs()
    const inheritedNoopenerPopup = noopenerTabs.find(tab =>
      tab.url.includes('popup=noopener'),
    )
    assert.ok(
      inheritedNoopenerPopup,
      `owned noopener popup was not listed: ${JSON.stringify(noopenerTabs)}`,
    )
    expectData(
      await run(tabsTool, {
        action: 'close',
        tabId: inheritedNoopenerPopup.targetId,
      }),
    )
    assert.equal(await countUserPages(), popupPagesBefore)
    console.log('ok [e2e] opener and noopener popup tabs inherit ownership')

    const crossFrame = expectData(
      await run(navigateTool, { url: `${fixture.url}cross-frame?e2e=1` }),
    )
    const crossFrameSnapshot = String(crossFrame.snapshot)
    const frameButton = refFor(
      crossFrameSnapshot,
      'button',
      'Inner frame action',
    )
    const frameClicked = expectData(await run(clickTool, { ref: frameButton }))
    assert.match(String(frameClicked.snapshot), /inner clicked/)
    const afterFrameClick = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const nestedFrameClicked = expectData(
      await run(clickTool, {
        ref: refFor(afterFrameClick, 'button', 'Nested frame action'),
      }),
    )
    assert.match(String(nestedFrameClicked.snapshot), /nested clicked/)
    const afterNestedFrame = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const sandboxRef = refFor(
      afterNestedFrame,
      'button',
      'Sandbox frame action',
    )
    const sandboxFrameClicked = expectData(
      await run(clickTool, {
        ref: sandboxRef,
      }),
    )
    assert.match(
      yamlFromObserve(sandboxFrameClicked),
      /sandbox clicked detail=[01]/,
      'sandbox click must arrive, using trusted Enter when mouse input is lost',
    )
    const afterSandboxFrame = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const shadowClicked = expectData(
      await run(clickTool, {
        ref: refFor(afterSandboxFrame, 'button', 'Shadow action'),
      }),
    )
    assert.match(String(shadowClicked.snapshot), /shadow clicked/)
    const beforeFrameDetach = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const soonDetachedRef = refFor(
      beforeFrameDetach,
      'button',
      'Inner frame action',
    )
    expectData(
      await run(clickTool, {
        ref: refFor(beforeFrameDetach, 'button', 'Remove inner frame'),
      }),
    )
    const detachedFrameClick = await run(clickTool, {
      ref: soonDetachedRef,
    })
    assert.equal(typeof detachedFrameClick, 'string')
    assert.match(String(detachedFrameClick), /stale|not found|snapshot/i)
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] nested/sandbox OOPIF, shadow DOM and detached refs work through chrome.debugger',
    )

    expectData(await run(navigateTool, { url: `${fixture.url}dynamic-dom` }))
    const dynamicInitial = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    assert.match(dynamicInitial, /button "Slotted first"/)
    assert.match(dynamicInitial, /button "Slotted second"/)
    expectData(
      await run(cdpTool, {
        method: 'Runtime.evaluate',
        params: {
          expression: 'reorderSlots(); churnDynamicFrame(); startDomChurn()',
        },
      }),
    )
    const churnSnapshotStartedAt = Date.now()
    const duringChurn = expectData(await run(snapshotTool, {}))
    assert.ok(
      Date.now() - churnSnapshotStartedAt < 8_000,
      'a continuously mutating DOM must not hold snapshot beyond its 8 second cap',
    )
    assert.match(String(duringChurn.snapshot), /Dynamic DOM matrix/)
    await new Promise(resolve => setTimeout(resolve, 2_100))
    const dynamicSettled = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    assert.match(dynamicSettled, /button "Slotted first"/)
    assert.match(dynamicSettled, /button "Slotted second"/)
    expectData(
      await run(clickTool, {
        ref: refFor(dynamicSettled, 'button', 'Slotted first'),
      }),
    )
    expectData(
      await run(clickTool, {
        ref: refFor(dynamicSettled, 'button', 'Slotted second'),
      }),
    )
    assert.match(dynamicSettled, /button "Inner frame action"/)
    const dynamicFrameClick = expectData(
      await run(clickTool, {
        ref: refFor(dynamicSettled, 'button', 'Inner frame action'),
      }),
    )
    assert.match(String(dynamicFrameClick.snapshot), /inner clicked/)

    const interactionRaces = expectData(
      await run(navigateTool, { url: `${fixture.url}interaction-races` }),
    )
    let raceSnapshot = String(interactionRaces.snapshot)
    const crossFrameDrag = await run(dragTool, {
      startRef: refFor(raceSnapshot, 'button', 'Cross frame source'),
      endRef: refFor(raceSnapshot, 'button', 'Cross frame target'),
    })
    assert.equal(typeof crossFrameDrag, 'string')
    assert.match(String(crossFrameDrag), /Cross-frame drag is not supported/i)
    assert.match(
      String(expectData(await run(snapshotTool, {})).snapshot),
      /cross frame idle/,
    )

    raceSnapshot = String(expectData(await run(snapshotTool, {})).snapshot)
    const scrollDrag = expectData(
      await run(dragTool, {
        startRef: refFor(raceSnapshot, 'button', 'Scroll drag source'),
        endRef: refFor(raceSnapshot, 'button', 'Scroll drag target'),
      }),
    )
    assert.match(String(scrollDrag.snapshot), /scroll drag dropped/)

    raceSnapshot = String(expectData(await run(snapshotTool, {})).snapshot)
    const detachDrag = await run(dragTool, {
      startRef: refFor(raceSnapshot, 'button', 'Detach drag source'),
      endRef: refFor(raceSnapshot, 'button', 'Detach drag target'),
    })
    if (typeof detachDrag === 'string') {
      assert.match(detachDrag, /detach|not found|stale|visible|timeout/i)
    } else {
      assert.match(
        String(expectData(detachDrag).snapshot),
        /detach target removed/,
      )
    }

    raceSnapshot = String(expectData(await run(snapshotTool, {})).snapshot)
    expectData(
      await run(hoverTool, {
        ref: refFor(raceSnapshot, 'button', 'Delayed hover menu'),
      }),
    )
    expectData(
      await run(waitForTool, {
        text: 'delayed menu visible',
        timeoutMs: 2_000,
      }),
    )
    raceSnapshot = String(expectData(await run(snapshotTool, {})).snapshot)
    const movingHover = expectData(
      await run(hoverTool, {
        ref: refFor(raceSnapshot, 'button', 'Moving hover target'),
      }),
    )
    assert.match(String(movingHover.snapshot), /moving hovered/)
    raceSnapshot = String(expectData(await run(snapshotTool, {})).snapshot)
    const vanishingHover = await run(hoverTool, {
      ref: refFor(raceSnapshot, 'button', 'Vanishing hover target'),
    })
    if (typeof vanishingHover === 'string') {
      assert.match(vanishingHover, /not found|not visible|stale|detach/i)
    }
    assert.match(
      String(expectData(await run(snapshotTool, {})).snapshot),
      /vanishing hovered and removed/,
    )

    const formRaces = expectData(
      await run(navigateTool, { url: `${fixture.url}form-races` }),
    )
    const formRaceSnapshot = String(formRaces.snapshot)
    const rerenderedForm = expectData(
      await run(fillFormTool, {
        fields: [
          {
            ref: refFor(formRaceSnapshot, 'textbox', 'Rerender trigger'),
            value: 'first landed',
          },
          {
            ref: refFor(formRaceSnapshot, 'textbox', 'Rerendered field'),
            value: 'must not land on replacement',
          },
        ],
      }),
    )
    assert.match(String(rerenderedForm.message), /Filled 1\/2 fields/)
    assert.match(String(rerenderedForm.message), /failed|stale|not found/i)

    const uploadRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-upload-races-'),
    )
    const firstSameDir = path.join(uploadRoot, 'one')
    const secondSameDir = path.join(uploadRoot, 'two')
    fs.mkdirSync(firstSameDir)
    fs.mkdirSync(secondSameDir)
    const firstSame = path.join(firstSameDir, 'same-name.txt')
    const secondSame = path.join(secondSameDir, 'same-name.txt')
    const largeUpload = path.join(uploadRoot, 'large-upload.bin')
    fs.writeFileSync(firstSame, 'first')
    fs.writeFileSync(secondSame, 'second')
    fs.writeFileSync(largeUpload, Buffer.alloc(12 * 1024 * 1024, 0x55))
    try {
      const uploadSnapshot = String(
        expectData(await run(snapshotTool, {})).snapshot,
      )
      const largeAndDuplicateUpload = expectData(
        await run(fileUploadTool, {
          ref: refFor(uploadSnapshot, 'button', 'Race upload'),
          paths: [firstSame, secondSame, largeUpload],
        }),
      )
      assert.match(
        String(largeAndDuplicateUpload.snapshot),
        /same-name\.txt:5, same-name\.txt:6, large-upload\.bin:12582912/,
      )

      const replacementPage = expectData(
        await run(navigateTool, { url: `${fixture.url}form-races?replace=1` }),
      )
      const replacementSnapshot = String(replacementPage.snapshot)
      expectData(
        await run(cdpTool, {
          method: 'Runtime.evaluate',
          params: { expression: 'replaceUploadSoon()' },
        }),
      )
      const replacedUpload = await run(fileUploadTool, {
        ref: refFor(replacementSnapshot, 'button', 'Race upload'),
        paths: [firstSame],
      })
      if (typeof replacedUpload === 'string') {
        assert.match(replacedUpload, /stale|not found|visible|snapshot/i)
      }
      assert.match(
        String(expectData(await run(snapshotTool, {})).snapshot),
        /upload input replaced|same-name\.txt:5/,
      )
    } finally {
      fs.rmSync(uploadRoot, { recursive: true, force: true })
    }

    const visualStress = expectData(
      await run(navigateTool, { url: `${fixture.url}visual-stress` }),
    )
    const visualSnapshot = String(visualStress.snapshot)
    const visualStartedAt = Date.now()
    const visualFullPage = expectData(
      await run(screenshotTool, { format: 'jpeg', fullPage: true }),
    )
    assert.ok(
      Date.now() - visualStartedAt < 20_000,
      'animated full-page screenshot must stay within its 20 second boundary',
    )
    const fullPageDimensions = readImageDimensions(
      fs.readFileSync(String(visualFullPage.screenshotPath)),
    )
    assert.ok(fullPageDimensions)
    assert.ok(fullPageDimensions.height >= 13_900)
    assert.ok(fullPageDimensions.width >= 600)

    const scaledShot = expectData(
      await run(screenshotTool, {
        ref: refFor(visualSnapshot, 'button', 'Scaled visual target'),
      }),
    )
    const scaledDimensions = readImageDimensions(
      fs.readFileSync(String(scaledShot.screenshotPath)),
    )
    assert.ok(scaledDimensions)
    assert.ok(scaledDimensions.width >= 200)
    assert.ok(scaledDimensions.height >= 100)
    const visualViewport = expectData(await run(screenshotTool, {}))
    assert.ok(
      Buffer.from(String(visualViewport.screenshotBase64), 'base64').length >
        1_000,
    )
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] dynamic, interaction, form/upload and long animated visual stress cases remain safe',
    )

    assert.ok(
      relay.capabilities().has('downloads.wait'),
      'the real extension must advertise chrome.downloads support',
    )
    assert.ok(
      relay.capabilities().has('downloads.cancel'),
      'the real extension must advertise cancellable download waits',
    )
    const downloadPage = expectData(
      await run(navigateTool, { url: `${fixture.url}download` }),
    )
    const downloadSnapshot = String(downloadPage.snapshot)
    const preClickAbortController = new AbortController()
    preClickAbortController.abort()
    const preClickAbortName = `agent-extension-pre-click-abort-${Date.now()}.csv`
    const preClickAbortPath = path.join(
      os.homedir(),
      'Downloads',
      preClickAbortName,
    )
    try {
      const preClickAbort = await run(
        waitForDownloadTool,
        {
          ref: refFor(downloadSnapshot, 'link', 'Download report'),
          path: preClickAbortName,
          timeoutMs: 10_000,
        },
        'e2e-pre-click-abort-download',
        preClickAbortController.signal,
      )
      assert.equal(typeof preClickAbort, 'string')
      assert.match(String(preClickAbort), /interrupted|cancelled/i)
      assert.equal(fs.existsSync(preClickAbortPath), false)
      assert.match(
        String(expectData(await run(snapshotTool, {})).snapshot),
        /paragraph.*idle/,
        'a pre-aborted download must not click its ref',
      )
    } finally {
      fs.rmSync(preClickAbortPath, { force: true })
    }
    const escapedDownload = await run(waitForDownloadTool, {
      ref: refFor(downloadSnapshot, 'link', 'Download report'),
      path: '../extension-e2e-outside.csv',
      timeoutMs: 1_000,
    })
    assert.equal(typeof escapedDownload, 'string')
    assert.match(String(escapedDownload), /Downloads can only be saved under/i)
    const noDownloadStartedAt = Date.now()
    const noDownload = await run(waitForDownloadTool, {
      ref: refFor(downloadSnapshot, 'button', 'Ordinary button'),
      path: `agent-extension-e2e-none-${Date.now()}.csv`,
      timeoutMs: 150,
    })
    assert.equal(typeof noDownload, 'string')
    assert.match(String(noDownload), /No download started/i)
    assert.ok(
      Date.now() - noDownloadStartedAt < 5_000,
      'real extension must honor the tool-level download timeout',
    )
    const downloadResult = expectData(
      await run(waitForDownloadTool, {
        ref: refFor(downloadSnapshot, 'link', 'Download report'),
        path: `agent-extension-e2e-${Date.now()}.csv`,
      }),
    )
    const downloadedPath = String(downloadResult.downloadPath)
    try {
      assert.equal(
        fs.readFileSync(downloadedPath, 'utf8'),
        'id,name\n1,Alice\n2,Bob\n',
      )
    } finally {
      fs.rmSync(downloadedPath, { force: true })
    }
    const scriptedDownloadName = `agent-extension-scripted-${Date.now()}.csv`
    const scriptedDownloadPath = path.join(
      os.homedir(),
      'Downloads',
      scriptedDownloadName,
    )
    try {
      const scriptedDownloadSnapshot = String(
        expectData(await run(snapshotTool, {})).snapshot,
      )
      const scriptedDownload = expectData(
        await run(waitForDownloadTool, {
          ref: refFor(
            scriptedDownloadSnapshot,
            'link',
            'Download scripted report',
          ),
          path: scriptedDownloadName,
          timeoutMs: 10_000,
        }),
      )
      assert.equal(
        fs.readFileSync(String(scriptedDownload.downloadPath), 'utf8'),
        'id,name\n9,Scripted\n',
      )
    } finally {
      fs.rmSync(scriptedDownloadPath, { force: true })
    }
    const concurrentDownloadSnapshot = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const concurrentDirectName = `agent-extension-concurrent-direct-${Date.now()}.csv`
    const concurrentDelayedName = `agent-extension-concurrent-delayed-${Date.now()}.csv`
    let concurrentDirectPath = path.join(
      os.homedir(),
      'Downloads',
      concurrentDirectName,
    )
    let concurrentDelayedPath = path.join(
      os.homedir(),
      'Downloads',
      concurrentDelayedName,
    )
    try {
      const [concurrentDirect, concurrentDelayed] = await Promise.all([
        run(waitForDownloadTool, {
          ref: refFor(concurrentDownloadSnapshot, 'link', 'Download report'),
          path: concurrentDirectName,
          timeoutMs: 10_000,
        }),
        run(waitForDownloadTool, {
          ref: refFor(
            concurrentDownloadSnapshot,
            'button',
            'Download after 5 seconds',
          ),
          path: concurrentDelayedName,
          timeoutMs: 10_000,
        }),
      ])
      concurrentDirectPath = String(expectData(concurrentDirect).downloadPath)
      concurrentDelayedPath = String(expectData(concurrentDelayed).downloadPath)
      assert.notEqual(concurrentDirectPath, concurrentDelayedPath)
      assert.equal(
        fs.readFileSync(concurrentDirectPath, 'utf8'),
        'id,name\n1,Alice\n2,Bob\n',
      )
      assert.equal(
        fs.readFileSync(concurrentDelayedPath, 'utf8'),
        'id,name\n3,Delayed\n',
      )
    } finally {
      fs.rmSync(concurrentDirectPath, { force: true })
      fs.rmSync(concurrentDelayedPath, { force: true })
    }
    const cancelledName = `agent-extension-cancelled-${Date.now()}.csv`
    const afterCancelName = `agent-extension-after-cancel-${Date.now()}.csv`
    const cancelledPath = path.join(os.homedir(), 'Downloads', cancelledName)
    const afterCancelPath = path.join(
      os.homedir(),
      'Downloads',
      afterCancelName,
    )
    try {
      const controller = new AbortController()
      const cancelledPending = run(
        waitForDownloadTool,
        {
          ref: refFor(
            concurrentDownloadSnapshot,
            'button',
            'Download after 5 seconds',
          ),
          path: cancelledName,
          timeoutMs: 10_000,
        },
        'e2e-cancelled-download',
        controller.signal,
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      controller.abort()
      const cancelled = await cancelledPending
      assert.equal(typeof cancelled, 'string')
      assert.match(String(cancelled), /interrupted by user|cancelled/i)

      const afterCancel = expectData(
        await run(waitForDownloadTool, {
          ref: refFor(concurrentDownloadSnapshot, 'link', 'Download report'),
          path: afterCancelName,
          timeoutMs: 10_000,
        }),
      )
      assert.equal(
        fs.readFileSync(String(afterCancel.downloadPath), 'utf8'),
        'id,name\n1,Alice\n2,Bob\n',
      )
    } finally {
      fs.rmSync(cancelledPath, { force: true })
      fs.rmSync(afterCancelPath, { force: true })
    }
    const claimedCancelName = `agent-extension-claimed-cancel-${Date.now()}.csv`
    const afterClaimedCancelName = `agent-extension-after-claimed-cancel-${Date.now()}.csv`
    const claimedCancelPath = path.join(
      os.homedir(),
      'Downloads',
      claimedCancelName,
    )
    const afterClaimedCancelPath = path.join(
      os.homedir(),
      'Downloads',
      afterClaimedCancelName,
    )
    try {
      const controller = new AbortController()
      const claimedCancelStartedAt = Date.now()
      const claimedCancelPending = run(
        waitForDownloadTool,
        {
          ref: refFor(
            concurrentDownloadSnapshot,
            'link',
            'Download slow report',
          ),
          path: claimedCancelName,
          timeoutMs: 10_000,
        },
        'e2e-claimed-cancel-download',
        controller.signal,
      )
      await new Promise(resolve => setTimeout(resolve, 1_000))
      controller.abort()
      const claimedCancel = await claimedCancelPending
      assert.equal(typeof claimedCancel, 'string')
      assert.match(String(claimedCancel), /interrupted by user|cancelled/i)
      assert.ok(
        Date.now() - claimedCancelStartedAt < 4_000,
        'cancelling a claimed in-progress download must not wait for Chrome to finish it',
      )

      const afterClaimedCancel = expectData(
        await run(waitForDownloadTool, {
          ref: refFor(concurrentDownloadSnapshot, 'link', 'Download report'),
          path: afterClaimedCancelName,
          timeoutMs: 10_000,
        }),
      )
      assert.equal(
        fs.readFileSync(String(afterClaimedCancel.downloadPath), 'utf8'),
        'id,name\n1,Alice\n2,Bob\n',
      )
    } finally {
      fs.rmSync(claimedCancelPath, { force: true })
      fs.rmSync(afterClaimedCancelPath, { force: true })
    }
    const largeDownloadName = `agent-extension-large-${Date.now()}.bin`
    const interruptedDownloadName = `agent-extension-interrupted-${Date.now()}.bin`
    const removedDownloadName = `agent-extension-removed-${Date.now()}.csv`
    const largeDownloadPath = path.join(
      os.homedir(),
      'Downloads',
      largeDownloadName,
    )
    const interruptedDownloadPath = path.join(
      os.homedir(),
      'Downloads',
      interruptedDownloadName,
    )
    const removedDownloadPath = path.join(
      os.homedir(),
      'Downloads',
      removedDownloadName,
    )
    try {
      const largeDownload = expectData(
        await run(waitForDownloadTool, {
          ref: refFor(
            concurrentDownloadSnapshot,
            'link',
            'Download large file',
          ),
          path: largeDownloadName,
          timeoutMs: 15_000,
        }),
      )
      assert.equal(
        fs.statSync(String(largeDownload.downloadPath)).size,
        8 * 1024 * 1024,
      )

      const interruptedDownload = await run(waitForDownloadTool, {
        ref: refFor(
          concurrentDownloadSnapshot,
          'link',
          'Download interrupted file',
        ),
        path: interruptedDownloadName,
        timeoutMs: 10_000,
      })
      assert.equal(typeof interruptedDownload, 'string')
      assert.match(
        String(interruptedDownload),
        /interrupted|NETWORK_FAILED|SERVER_FAILED/i,
      )
      assert.equal(fs.existsSync(interruptedDownloadPath), false)

      const removedDownloadPending = run(waitForDownloadTool, {
        ref: refFor(
          concurrentDownloadSnapshot,
          'link',
          'Download removable report',
        ),
        path: removedDownloadName,
        timeoutMs: 10_000,
      })
      const erased = await chrome.cdp.send<{
        result: { value: number | null }
      }>(
        'Runtime.evaluate',
        {
          expression: `(async () => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              const items = await chrome.downloads.search({});
              const item = items.find(candidate =>
                /removable(?: \\(\\d+\\))?\\.csv$/.test(candidate.filename || '')
              );
              if (item) {
                await new Promise(resolve => setTimeout(resolve, 500));
                await chrome.downloads.erase({ id: item.id });
                return item.id;
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            return null;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        workerSession,
      )
      assert.equal(typeof erased.result.value, 'number')
      const removedDownload = await removedDownloadPending
      assert.equal(typeof removedDownload, 'string')
      assert.match(String(removedDownload), /removed.*download list/i)
      assert.equal(fs.existsSync(removedDownloadPath), false)
    } finally {
      fs.rmSync(largeDownloadPath, { force: true })
      fs.rmSync(interruptedDownloadPath, { force: true })
      fs.rmSync(removedDownloadPath, { force: true })
    }
    const firstDownloadTabId = getCurrentTabId('extension-e2e')
    assert.ok(firstDownloadTabId)
    const managedBackend = await getBrowser(process.cwd(), 'extension-e2e')
    expectData(
      await run(tabsTool, {
        action: 'new',
        url: `${fixture.url}download`,
      }),
    )
    const secondDownloadTabId = getCurrentTabId('extension-e2e')
    assert.ok(secondDownloadTabId)
    assert.notEqual(secondDownloadTabId, firstDownloadTabId)
    const secondDownloadSnapshot = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const crossTabDirectName = `agent-extension-cross-tab-direct-${Date.now()}.csv`
    const crossTabDelayedName = `agent-extension-cross-tab-delayed-${Date.now()}.csv`
    const crossTabAbortedName = `agent-extension-cross-tab-aborted-${Date.now()}.csv`
    const crossTabDirectPath = path.join(
      os.homedir(),
      'Downloads',
      crossTabDirectName,
    )
    const crossTabDelayedPath = path.join(
      os.homedir(),
      'Downloads',
      crossTabDelayedName,
    )
    const crossTabAbortedPath = path.join(
      os.homedir(),
      'Downloads',
      crossTabAbortedName,
    )
    try {
      const crossTabDelayedPending = downloadByRef(
        managedBackend,
        firstDownloadTabId,
        {
          ref: refFor(
            concurrentDownloadSnapshot,
            'button',
            'Download after 5 seconds',
          ),
          path: crossTabDelayedName,
          timeoutMs: 10_000,
        },
      )
      await new Promise(resolve => setTimeout(resolve, 100))
      const queuedAbortController = new AbortController()
      const queuedAbortStartedAt = Date.now()
      const queuedAbortPending = downloadByRef(
        managedBackend,
        secondDownloadTabId,
        {
          ref: refFor(secondDownloadSnapshot, 'link', 'Download report'),
          path: crossTabAbortedName,
          timeoutMs: 10_000,
          signal: queuedAbortController.signal,
        },
      )
      await new Promise(resolve => setTimeout(resolve, 200))
      queuedAbortController.abort(new Error('queued download cancelled'))
      await assert.rejects(queuedAbortPending, /queued download cancelled/)
      assert.ok(
        Date.now() - queuedAbortStartedAt < 2_000,
        'an aborted queued download must not wait for the active download',
      )
      const crossTabDirectPending = downloadByRef(
        managedBackend,
        secondDownloadTabId,
        {
          ref: refFor(secondDownloadSnapshot, 'link', 'Download report'),
          path: crossTabDirectName,
          timeoutMs: 10_000,
        },
      )
      const [crossTabDelayed, crossTabDirect] = await Promise.all([
        crossTabDelayedPending,
        crossTabDirectPending,
      ])
      assert.equal(
        fs.readFileSync(crossTabDirect.path, 'utf8'),
        'id,name\n1,Alice\n2,Bob\n',
      )
      assert.equal(
        fs.readFileSync(crossTabDelayed.path, 'utf8'),
        'id,name\n3,Delayed\n',
      )
    } finally {
      fs.rmSync(crossTabDirectPath, { force: true })
      fs.rmSync(crossTabDelayedPath, { force: true })
      fs.rmSync(crossTabAbortedPath, { force: true })
      expectData(
        await run(tabsTool, {
          action: 'close',
          tabId: secondDownloadTabId,
        }),
      )
      expectData(
        await run(tabsTool, {
          action: 'select',
          tabId: firstDownloadTabId,
        }),
      )
    }
    expectData(await run(navigateTool, { url: fixture.url }))
    console.log(
      'ok [e2e] download rejects path escape, honors timeout and isolates concurrent chrome.downloads',
    )

    // ── tabs really open and close in the user's browser ──
    const pagesBefore = await countUserPages()
    const backgroundCandidate = expectData(await run(snapshotTool, {}))
    const backgroundCandidateRef = refFor(
      String(backgroundCandidate.snapshot),
      'button',
      'Clicked 0 times',
    )
    const opened = expectData(
      await run(tabsTool, { action: 'new', url: fixture.url }),
    )
    assert.equal((opened.tabs as unknown[]).length, 2)
    assert.equal(await countUserPages(), pagesBefore + 1)

    const originalTabId = (
      opened.tabs as Array<{ targetId: string; current?: boolean }>
    ).find(t => !t.current)!.targetId
    const newTabId = (
      opened.tabs as Array<{ targetId: string; current?: boolean }>
    ).find(t => t.current)!.targetId
    expectData(await run(tabsTool, { action: 'select', tabId: originalTabId }))
    const backgroundClick = expectData(
      await run(clickTool, { ref: backgroundCandidateRef }),
    )
    assert.match(
      String(backgroundClick.snapshot),
      /Clicked 1 times/,
      'a click must reach an owned tab after another tab backgrounds it',
    )
    console.log('ok [e2e] click reaches a backgrounded owned tab')

    expectData(await run(tabsTool, { action: 'select', tabId: newTabId }))
    const sameUrlNewTab = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    assert.match(sameUrlNewTab, /button "Clicked 0 times"/)
    assert.doesNotMatch(sameUrlNewTab, /button "Clicked 1 times"/)
    expectData(await run(tabsTool, { action: 'select', tabId: originalTabId }))
    assert.match(
      String(expectData(await run(snapshotTool, {})).snapshot),
      /button "Clicked 1 times"/,
    )
    console.log('ok [e2e] same-URL tabs retain distinct page identity')

    const afterClose = expectData(
      await run(tabsTool, { action: 'close', tabId: newTabId }),
    )
    assert.equal((afterClose.tabs as unknown[]).length, 1)
    assert.equal(
      await countUserPages(),
      pagesBefore,
      'closing a tab must actually remove it from Chrome',
    )
    const closedAgain = await run(tabsTool, {
      action: 'close',
      tabId: newTabId,
    })
    assert.equal(typeof closedAgain, 'string')
    assert.match(String(closedAgain), /No open tab|not found|closed/i)
    console.log('ok [e2e] tab open/close round-trips through chrome.tabs')

    const movedTab = expectData(
      await run(tabsTool, {
        action: 'new',
        url: `${fixture.url}?window=moved`,
      }),
    )
    const movedTabId = (
      movedTab.tabs as Array<{ targetId: string; current?: boolean }>
    ).find(tab => tab.current)!.targetId
    let movedWindowId: number | undefined
    try {
      const movedWindow = await chrome.cdp.send<{
        result: { value: { id?: number } }
      }>(
        'Runtime.evaluate',
        {
          expression: `chrome.windows.create({
            tabId: ${Number(movedTabId)},
            focused: false,
            type: "normal"
          })`,
          awaitPromise: true,
          returnByValue: true,
        },
        workerSession,
      )
      movedWindowId = movedWindow.result.value.id
      assert.equal(typeof movedWindowId, 'number')

      const afterMove = expectData(await run(tabsTool, { action: 'list' }))
      assert.ok(
        (afterMove.tabs as Array<{ targetId: string; current?: boolean }>).some(
          tab => tab.targetId === movedTabId,
        ),
        'moving an owned tab to another window must preserve ownership',
      )
      expectData(await run(tabsTool, { action: 'select', tabId: movedTabId }))
      const movedLocation = expectData(
        await run(cdpTool, {
          method: 'Runtime.evaluate',
          params: { expression: 'location.search', returnByValue: true },
        }),
      )
      assert.equal(
        (
          movedLocation.value as {
            result?: { value?: string }
          }
        ).result?.value,
        '?window=moved',
      )

      expectData(
        await run(tabsTool, { action: 'select', tabId: originalTabId }),
      )
      await chrome.cdp.send(
        'Runtime.evaluate',
        {
          expression: `chrome.windows.remove(${movedWindowId})`,
          awaitPromise: true,
          returnByValue: true,
        },
        workerSession,
      )
      await waitFor(
        'moved tab to disappear after its window closes',
        async () => {
          return !(await backend.listTabs()).some(
            tab => tab.targetId === movedTabId,
          )
        },
      )
      movedWindowId = undefined
      const afterWindowClose = expectData(
        await run(tabsTool, { action: 'list' }),
      )
      assert.deepEqual(
        (afterWindowClose.tabs as Array<{ targetId: string }>).map(
          tab => tab.targetId,
        ),
        [originalTabId],
      )
      assert.equal(await countUserPages(), pagesBefore)
      console.log(
        'ok [e2e] owned tabs survive cross-window moves and clean up on window close',
      )
    } finally {
      if (movedWindowId !== undefined) {
        await chrome.cdp
          .send(
            'Runtime.evaluate',
            {
              expression: `chrome.windows.remove(${movedWindowId})`,
              awaitPromise: true,
            },
            workerSession,
          )
          .catch(() => {})
      }
    }

    const stressTabIds: string[] = []
    try {
      for (let index = 0; index < 12; index += 1) {
        const created = expectData(
          await run(tabsTool, {
            action: 'new',
            url: `${fixture.url}?tab-stress=${index}`,
          }),
        )
        const current = (
          created.tabs as Array<{ targetId: string; current?: boolean }>
        ).find(tab => tab.current)
        assert.ok(current)
        stressTabIds.push(current.targetId)
      }
      assert.equal(new Set(stressTabIds).size, stressTabIds.length)
      assert.equal(
        (expectData(await run(tabsTool, { action: 'list' })).tabs as unknown[])
          .length,
        stressTabIds.length + 1,
      )

      for (const tabId of [...stressTabIds].reverse()) {
        const selected = expectData(
          await run(tabsTool, { action: 'select', tabId }),
        )
        assert.equal(
          (
            selected.tabs as Array<{ targetId: string; current?: boolean }>
          ).find(tab => tab.current)?.targetId,
          tabId,
        )
      }
      expectData(
        await run(tabsTool, { action: 'select', tabId: originalTabId }),
      )
      for (const tabId of [...stressTabIds].reverse()) {
        expectData(await run(tabsTool, { action: 'close', tabId }))
      }
      stressTabIds.length = 0
      const afterStress = expectData(await run(tabsTool, { action: 'list' }))
      assert.deepEqual(
        (afterStress.tabs as Array<{ targetId: string }>).map(
          tab => tab.targetId,
        ),
        [originalTabId],
      )
      assert.equal(await countUserPages(), pagesBefore)
      console.log(
        'ok [e2e] rapid 12-tab new/select/close cycles preserve order and clean up',
      )
    } finally {
      for (const tabId of stressTabIds) {
        await run(tabsTool, { action: 'close', tabId }).catch(() => {})
      }
      await run(tabsTool, {
        action: 'select',
        tabId: originalTabId,
      }).catch(() => {})
    }

    const groups = await chrome.cdp.send<{ result: { value: unknown } }>(
      'Runtime.evaluate',
      {
        expression: 'chrome.tabGroups.query({ title: "Agent" })',
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession,
    )
    const found = groups.result.value as Array<{ color: string }>
    assert.equal(
      found.length,
      1,
      'agent tabs should live in one labelled group',
    )
    assert.equal(found[0].color, 'orange')
    console.log('ok [e2e] agent tabs collected into a labelled tab group')

    const lifecycleTabsBefore = (
      expectData(await run(tabsTool, { action: 'list' })).tabs as Array<{
        targetId: string
      }>
    ).map(tab => tab.targetId)
    const lifecyclePagesBefore = await countUserPages()
    const lifecycleDownloadsBefore = fs.readdirSync(chromeDownloadDir).sort()
    const attachedDebuggersBefore = await chrome.cdp.send<{
      result: { value: Array<{ attached: boolean; targetId: string }> }
    }>(
      'Runtime.evaluate',
      {
        expression: 'chrome.debugger.getTargets()',
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession,
    )
    const attachedTargetIdsBefore = attachedDebuggersBefore.result.value
      .filter(target => target.attached)
      .map(target => target.targetId)
      .sort()

    for (let index = 0; index < 100; index += 1) {
      const evaluated = expectData(
        await run(cdpTool, {
          method: 'Runtime.evaluate',
          params: {
            expression: `${index} + 1`,
            returnByValue: true,
          },
        }),
      )
      assert.equal(
        (
          evaluated.value as {
            result?: { value?: number }
          }
        ).result?.value,
        index + 1,
      )
      if (index % 10 === 0) {
        expectData(await run(snapshotTool, {}))
        expectData(await run(tabsTool, { action: 'list' }))
      }
    }

    const lifecycleTabsAfter = (
      expectData(await run(tabsTool, { action: 'list' })).tabs as Array<{
        targetId: string
      }>
    ).map(tab => tab.targetId)
    const attachedDebuggersAfter = await chrome.cdp.send<{
      result: { value: Array<{ attached: boolean; targetId: string }> }
    }>(
      'Runtime.evaluate',
      {
        expression: 'chrome.debugger.getTargets()',
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession,
    )
    assert.deepEqual(lifecycleTabsAfter, lifecycleTabsBefore)
    assert.equal(await countUserPages(), lifecyclePagesBefore)
    assert.deepEqual(
      fs.readdirSync(chromeDownloadDir).sort(),
      lifecycleDownloadsBefore,
    )
    assert.deepEqual(
      attachedDebuggersAfter.result.value
        .filter(target => target.attached)
        .map(target => target.targetId)
        .sort(),
      attachedTargetIdsBefore,
    )
    assert.equal(relay.isConnected(), true)
    console.log(
      'ok [e2e] 120 mixed sequential operations leave tabs, downloads and debugger sessions stable',
    )

    const workerDownloadPage = expectData(
      await run(navigateTool, { url: `${fixture.url}download?worker-stop=1` }),
    )
    const workerDownloadName = `agent-extension-worker-stop-${Date.now()}.csv`
    const workerDownloadPath = path.join(
      os.homedir(),
      'Downloads',
      workerDownloadName,
    )
    const { targetInfos: beforeWorkerReload } = await chrome.cdp.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }>('Target.getTargets')
    const oldWorkerTarget = beforeWorkerReload.find(
      target =>
        target.type === 'service_worker' &&
        target.url.startsWith(`chrome-extension://${chrome.extensionId}/`),
    )
    assert.ok(
      oldWorkerTarget,
      'extension service worker must exist before reload',
    )
    const storedBeforeWorkerStop = await chrome.cdp.send<{
      result: { value: Record<string, unknown> }
    }>(
      'Runtime.evaluate',
      {
        expression: 'chrome.storage.local.get(null)',
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession,
    )
    assert.equal(
      typeof storedBeforeWorkerStop.result.value.recoverableRelayUrl,
      'string',
      'the relay recovery endpoint must survive an explicit extension reload',
    )
    // A service-worker target may stay listed after it stops, and
    // Target.closeTarget can be ignored while debugger/WebSocket activity keeps
    // it alive. The ServiceWorker domain force-stops the worker; the relay
    // disconnect is the observable lifecycle boundary we actually depend on.
    const controlPage = beforeWorkerReload.find(
      target => target.type === 'page' && target.url.startsWith(fixture.url),
    )
    assert.ok(
      controlPage,
      'an owned page must exist to control service workers',
    )
    const controlSession = (
      await chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: controlPage.targetId,
        flatten: true,
      })
    ).sessionId
    await chrome.cdp.send('ServiceWorker.enable', {}, controlSession)
    const waitStartedBeforeWorkerStop = Date.now()
    const interruptedByWorkerStopPending = run(
      waitForTool,
      { text: 'Never appears after worker stop', timeoutMs: 20_000 },
      'e2e-worker-stop-wait',
    )
    const cdpInterruptedByWorkerStopPending = run(
      cdpTool,
      {
        method: 'Runtime.evaluate',
        params: {
          expression:
            'new Promise(resolve => setTimeout(() => resolve("late"), 20000))',
          awaitPromise: true,
          returnByValue: true,
        },
      },
      'e2e-worker-stop-cdp',
    )
    const downloadInterruptedByWorkerStopPending = run(
      waitForDownloadTool,
      {
        ref: refFor(
          String(workerDownloadPage.snapshot),
          'button',
          'Download after 5 seconds',
        ),
        path: workerDownloadName,
        timeoutMs: 20_000,
      },
      'e2e-worker-stop-download',
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    await chrome.cdp.send('ServiceWorker.stopAllWorkers', {}, controlSession)
    await waitFor(
      'extension relay to disconnect with its worker',
      () => !relay.isConnected(),
    )
    const interruptedByWorkerStop = await interruptedByWorkerStopPending
    const cdpInterruptedByWorkerStop = await cdpInterruptedByWorkerStopPending
    const downloadInterruptedByWorkerStop =
      await downloadInterruptedByWorkerStopPending
    assert.equal(typeof interruptedByWorkerStop, 'string')
    assert.equal(typeof cdpInterruptedByWorkerStop, 'string')
    assert.equal(typeof downloadInterruptedByWorkerStop, 'string')
    assert.match(
      String(interruptedByWorkerStop),
      /disconnect|extension|closed|interrupted/i,
    )
    assert.match(
      String(cdpInterruptedByWorkerStop),
      /disconnect|extension|closed|interrupted|session/i,
    )
    assert.match(
      String(downloadInterruptedByWorkerStop),
      /disconnect|extension|closed|interrupted/i,
    )
    assert.ok(
      Date.now() - waitStartedBeforeWorkerStop < 5_000,
      'an in-flight browser tool must fail promptly when the extension worker stops',
    )
    const wakePage = await chrome.cdp.send<{ targetId: string }>(
      'Target.createTarget',
      { url: `chrome-extension://${chrome.extensionId}/popup.html` },
    )
    let restartedWorker:
      { targetId: string; type: string; url: string } | undefined
    await waitFor('extension service worker to wake again', async () => {
      const { targetInfos } = await chrome.cdp.send<{
        targetInfos: Array<{ targetId: string; type: string; url: string }>
      }>('Target.getTargets')
      restartedWorker = targetInfos.find(
        target =>
          target.type === 'service_worker' &&
          target.url.startsWith(`chrome-extension://${chrome.extensionId}/`),
      )
      return restartedWorker !== undefined
    })
    workerSession = (
      await chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: restartedWorker!.targetId,
        flatten: true,
      })
    ).sessionId
    await waitFor('extension to reconnect after worker reload', () =>
      relay.isConnected(),
    )
    await chrome.cdp.send('Target.closeTarget', { targetId: wakePage.targetId })
    const afterWorkerRestart = expectData(
      await run(navigateTool, { url: `${fixture.url}?worker=reloaded` }),
    )
    assert.match(String(afterWorkerRestart.url), /worker=reloaded/)
    assert.equal((await backend.listTabs()).length, 1)
    fs.rmSync(workerDownloadPath, { force: true })
    console.log(
      'ok [e2e] service worker termination interrupts in-flight work and preserves recovery state',
    )

    // ── the popup, actually clicked ──────────────────────
    // Opened as an ordinary tab so its buttons can be driven; it is the same
    // document and the same messaging path as the real popup.
    const popup = await chrome.cdp.send<{ targetId: string }>(
      'Target.createTarget',
      { url: `chrome-extension://${chrome.extensionId}/popup.html` },
    )
    const { sessionId: popupSession } = await chrome.cdp.send<{
      sessionId: string
    }>('Target.attachToTarget', { targetId: popup.targetId, flatten: true })

    const readPopup = async () => {
      const res = await chrome.cdp.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        {
          // Null-safe: the popup document may not have parsed yet.
          expression: `(() => {
            const status = document.getElementById('status');
            if (!status) return null;
            return {
              status: status.textContent,
              tokenMasked: document.getElementById('token').textContent.startsWith('•'),
              tabCount: document.querySelectorAll('#tabs li:not(.empty)').length,
            };
          })()`,
          returnByValue: true,
        },
        popupSession,
      )
      return res.result.value as {
        status: string
        tokenMasked: boolean
        tabCount: number
      } | null
    }

    let lastPopupState: Awaited<ReturnType<typeof readPopup>> = null
    try {
      await waitFor('popup to render connected state', async () => {
        lastPopupState = await readPopup()
        return (
          lastPopupState?.status === 'connected' &&
          lastPopupState.tabCount === 1
        )
      })
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; last popup state=${JSON.stringify(lastPopupState)}`,
        { cause: err },
      )
    }
    const popupState = await readPopup()
    assert.equal(
      popupState?.tokenMasked,
      true,
      'the auto-connect token should be masked until asked for',
    )
    console.log('ok [e2e] popup shows connected and lists the shared tab')

    const revokeStartedAt = Date.now()
    const interruptedByRevokePending = run(
      waitForTool,
      { text: 'Never appears after ownership revoke', timeoutMs: 20_000 },
      'e2e-revoke-in-flight',
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: `document.querySelector('#tabs li button').click()` },
      popupSession,
    )
    await waitFor('agent to lose the tab', async () => {
      return (await backend.listTabs()).length === 0
    })
    const interruptedByRevoke = await interruptedByRevokePending
    assert.equal(typeof interruptedByRevoke, 'string')
    assert.match(
      String(interruptedByRevoke),
      /not shared|unshared|closed|detached|target|session|interrupted/i,
    )
    assert.ok(
      Date.now() - revokeStartedAt < 5_000,
      'revoking a shared tab must interrupt in-flight work promptly',
    )
    const afterRevoke = await backend
      .send(visible[0].targetId, 'Runtime.evaluate', { expression: '1' })
      .then(() => 'allowed')
      .catch((err: Error) => err.message)
    assert.match(
      String(afterRevoke),
      /not shared with the agent/,
      `revoking from the popup must actually revoke access, got: ${afterRevoke}`,
    )
    console.log('ok [e2e] revoking a tab from the popup cuts the agent off')

    // Owned list is empty. navigate must open a new owned tab at the requested
    // URL — not bind some other page still sitting in the user's Chrome.
    const emptyNav = expectData(
      await run(navigateTool, { url: `${fixture.url}dialog-lazy` }),
    )
    assert.match(
      String(emptyNav.url),
      /dialog-lazy/,
      `empty owned list must create+navigate a new tab, got url=${emptyNav.url}`,
    )
    const ownedAgain = await backend.listTabs()
    assert.equal(
      ownedAgain.length,
      1,
      `expected one newly owned tab, saw: ${JSON.stringify(ownedAgain)}`,
    )
    assert.match(ownedAgain[0].url, /dialog-lazy/)
    assert.ok(
      String(emptyNav.snapshot).includes('Hiring home') ||
        String(emptyNav.snapshot).includes('有新消息'),
      `new tab snapshot must be the fixture, not another page:\n${String(emptyNav.snapshot).slice(0, 400)}`,
    )
    console.log('ok [e2e] empty owned list → navigate opens a new owned tab')

    const tabBeforeAbort = (await backend.listTabs())[0].targetId
    const navigationAbort = new AbortController()
    const abortedNavigationPending = run(
      navigateTool,
      { url: `${fixture.url}hang-frame` },
      'e2e-aborted-navigation',
      navigationAbort.signal,
    )
    setTimeout(() => navigationAbort.abort(), 500)
    const abortedNavigation = await abortedNavigationPending
    assert.equal(typeof abortedNavigation, 'string')
    assert.match(String(abortedNavigation), /interrupted by user/i)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const afterAbortedNavigation = expectData(
      await run(navigateTool, { url: `${fixture.url}?abort=reused` }),
    )
    assert.match(String(afterAbortedNavigation.url), /abort=reused/)
    const tabsAfterAbort = await backend.listTabs()
    assert.deepEqual(
      tabsAfterAbort.map(tab => tab.targetId),
      [tabBeforeAbort],
      'an aborted navigation must keep the original tab usable',
    )
    console.log('ok [e2e] abort stops navigation without poisoning its tab')

    const tabBeforeHostClose = (await backend.listTabs())[0].targetId
    const hostCloseStartedAt = Date.now()
    const hostClosedNavigationPending = run(
      navigateTool,
      { url: `${fixture.url}hang-frame` },
      'e2e-host-closed-navigation',
    )
    await new Promise(resolve => setTimeout(resolve, 500))
    await backend.closeTab(tabBeforeHostClose)
    const hostClosedNavigation = await hostClosedNavigationPending
    assert.equal(typeof hostClosedNavigation, 'string')
    assert.match(
      String(hostClosedNavigation),
      /closed|target|session|tab|page/i,
    )
    assert.ok(
      Date.now() - hostCloseStartedAt < 5_000,
      'closing a navigating extension tab must interrupt the tool promptly',
    )
    assert.ok(
      !(await backend.listTabs()).some(
        tab => tab.targetId === tabBeforeHostClose,
      ),
    )
    const afterHostClose = expectData(
      await run(navigateTool, { url: `${fixture.url}?host-close=recovered` }),
    )
    assert.match(String(afterHostClose.url), /host-close=recovered/)
    assert.notEqual(
      getCurrentTabId('extension-e2e'),
      tabBeforeHostClose,
      'recovery must create a fresh tab after the current one is closed',
    )
    console.log(
      'ok [e2e] closing an in-flight navigation fails promptly and recovers',
    )

    const beforeAbortedNew = await backend.listTabs()
    const newTabAbort = new AbortController()
    const abortedNewPending = run(
      tabsTool,
      { action: 'new', url: `${fixture.url}hang-frame` },
      'e2e-aborted-new-tab',
      newTabAbort.signal,
    )
    setTimeout(() => newTabAbort.abort(), 500)
    const abortedNew = await abortedNewPending
    assert.equal(typeof abortedNew, 'string')
    assert.match(String(abortedNew), /interrupted by user/i)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const afterAbortedNew = await backend.listTabs()
    assert.deepEqual(
      afterAbortedNew.map(tab => tab.targetId),
      beforeAbortedNew.map(tab => tab.targetId),
      'aborting a new-tab navigation must close the unfinished tab',
    )
    assert.equal(
      getCurrentTabId('extension-e2e'),
      beforeAbortedNew[0].targetId,
      'aborting a new tab must restore the previous current tab',
    )
    console.log('ok [e2e] abort closes an unfinished new tab')

    const beforeFailedNew = await backend.listTabs()
    const failedNewTab = await run(tabsTool, {
      action: 'new',
      url: `${fixture.url}hang-frame`,
    })
    assert.equal(typeof failedNewTab, 'string')
    assert.match(
      String(failedNewTab),
      /Navigation timed out and the resulting page state could not be verified/,
    )
    const afterFailedNew = await backend.listTabs()
    assert.deepEqual(
      afterFailedNew.map(tab => tab.targetId),
      beforeFailedNew.map(tab => tab.targetId),
      'a failed initial navigation must not leak its newly created tab',
    )
    assert.equal(
      getCurrentTabId('extension-e2e'),
      beforeFailedNew[0].targetId,
      'a failed new tab must restore the previously selected tab',
    )
    console.log('ok [e2e] failed new-tab navigation closes the poisoned tab')

    const beforePoisonSnapshot = String(
      expectData(await run(snapshotTool, {})).snapshot,
    )
    const tabBeforePoison = (await backend.listTabs())[0].targetId
    const poisonedNavigation = await run(navigateTool, {
      url: `${fixture.url}hang-frame`,
    })
    assert.equal(typeof poisonedNavigation, 'string')
    assert.match(
      String(poisonedNavigation),
      /Navigation timed out and the resulting page state could not be verified/,
    )
    assert.match(String(poisonedNavigation), /fresh blank tab/i)
    const replacementAfterPoison = getCurrentTabId('extension-e2e')
    assert.ok(replacementAfterPoison)
    assert.notEqual(
      replacementAfterPoison,
      tabBeforePoison,
      'a poisoned navigation must immediately move current to a fresh tab',
    )
    const staleClickAfterReplacement = await run(clickTool, {
      ref: refFor(beforePoisonSnapshot, 'button', 'Clicked 0 times'),
    })
    assert.equal(typeof staleClickAfterReplacement, 'string')
    assert.doesNotMatch(
      String(staleClickAfterReplacement),
      /not rendering|minimized|covered by other windows/i,
      'a poisoned tab must not leak into the next mutation as a rendering error',
    )
    const recoveredNavigation = expectData(
      await run(navigateTool, { url: `${fixture.url}?poison=recovered` }),
    )
    assert.match(String(recoveredNavigation.url), /poison=recovered/)
    const afterPoisonRecovery = await backend.listTabs()
    assert.equal(afterPoisonRecovery.length, 1)
    assert.ok(
      afterPoisonRecovery.some(
        tab =>
          tab.targetId !== tabBeforePoison && /poison=recovered/.test(tab.url),
      ),
      'the recovery navigation must use a fresh tab',
    )
    console.log(
      'ok [e2e] poisoned navigation replaces and closes the unusable tab',
    )

    // ── the extension survives the agent going away ──────
    await relay.close()
    await waitFor('extension to notice the drop', async () => {
      const status = await chrome.cdp.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        {
          expression: 'chrome.storage.local.get("status")',
          awaitPromise: true,
          returnByValue: true,
        },
        workerSession,
      )
      return (
        (status.result.value as { status?: string })?.status === 'disconnected'
      )
    })
    console.log('ok [e2e] extension reports disconnect and stays alive')

    // ── auto-connect token: no Allow click ───────────────
    const tokenRes = await chrome.cdp.send<{ result: { value: unknown } }>(
      'Runtime.evaluate',
      {
        expression: 'chrome.storage.local.get("pairingToken")',
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession,
    )
    const pairingToken = (tokenRes.result.value as { pairingToken?: string })
      ?.pairingToken
    assert.ok(pairingToken, 'the extension generates a token on boot')

    const wrongRelay = await startRelayServer()
    try {
      await chrome.cdp.send('Target.createTarget', {
        url: wrongRelay.connectUrl('Baize e2e', 'not-the-token'),
      })
      await new Promise(r => setTimeout(r, 1500))
      assert.equal(
        wrongRelay.isConnected(),
        false,
        'a wrong token must not connect',
      )
    } finally {
      await wrongRelay.close()
    }
    console.log('ok [e2e] a wrong token is refused')

    const tokenRelay = await startRelayServer()
    try {
      const connectPagesBefore = await countConnectPages()
      await chrome.cdp.send('Target.createTarget', {
        url: tokenRelay.connectUrl('Baize e2e', pairingToken),
      })
      await waitFor('auto-connect with token', () => tokenRelay.isConnected())
      await waitFor(
        'connect tab to close itself',
        async () => (await countConnectPages()) === connectPagesBefore,
      )
    } finally {
      await tokenRelay.close()
    }
    console.log(
      'ok [e2e] the right token connects without a click and closes its tab',
    )

    console.log('\nall real-extension end-to-end tests passed')
  } finally {
    setBrowserBackendFactory(null)
    await closeBrowser().catch(() => {})
    await chrome.close()
    await relay.close().catch(() => {})
    await fixture.close()
    fs.rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
