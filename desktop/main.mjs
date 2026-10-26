/**
 * Electron main process — starts the agent HTTP server as a child process,
 * then opens a BrowserWindow pointed at the same origin the web build uses
 * in production (http://127.0.0.1:<PORT>).
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session as electronSession,
} from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import brand from '../brand.json' with { type: 'json' }
import {
  buildAgentSpawnEnv,
  resolveAgentLaunch,
  resolveAgentNodeExecPath,
  resolveDesktopDataRoot,
  resolveDefaultDesktopWorkspace,
  assertSafeDesktopDataRoot,
} from './agent-launch.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const APP_NAME = brand.name
const SLUG = brand.slug || 'baize'
const DEFAULT_PORT = 4567
let agentProc = null
let mainWindow = null
let agentPort = DEFAULT_PORT
let agentStopDone = false
let factoryResetInProgress = false

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : REPO_ROOT
}

function getWebDistDir() {
  return path.join(getAppRoot(), 'web', 'dist')
}

function getAgentUrl() {
  return `http://127.0.0.1:${agentPort}`
}

function getAgentLogPath() {
  try {
    return path.join(app.getPath('userData'), 'agent-stderr.log')
  } catch {
    return path.join(REPO_ROOT, 'agent-stderr.log')
  }
}

function pipeAgentLogs(proc, extraHeader) {
  const logPath = getAgentLogPath()
  let logStream = null
  try {
    logStream = fs.createWriteStream(logPath, { flags: 'a' })
    logStream.write(`\n---- agent start ${new Date().toISOString()} ----\n`)
    if (extraHeader) logStream.write(`${extraHeader}\n`)
  } catch {
    logStream = null
  }

  const write = (label, chunk) => {
    const text = String(chunk)
    process.stderr.write(`[agent:${label}] ${text}`)
    logStream?.write(`[${label}] ${text}`)
  }

  proc.stdout?.on('data', chunk => write('out', chunk))
  proc.stderr?.on('data', chunk => write('err', chunk))
  proc.on('close', () => logStream?.end())
}

function startAgent() {
  const appRoot = getAppRoot()
  const appDataDir = resolveDesktopDataRoot(app.getPath('home'), process.env)
  const workspace = resolveDefaultDesktopWorkspace({
    packaged: app.isPackaged,
    homeDir: app.getPath('home'),
  })
  if (workspace) {
    fs.mkdirSync(workspace, { recursive: true })
  }

  const env = buildAgentSpawnEnv(appRoot, agentPort, process.env, {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    workspace,
    appDataDir,
  })

  const launch = resolveAgentLaunch(appRoot, SLUG, {
    packaged: app.isPackaged,
  })
  if (launch.kind === 'error') {
    dialog.showErrorBox('Agent failed to start', launch.message)
    app.quit()
    return
  }

  const launchEntry =
    launch.kind === 'native'
      ? launch.entry
      : launch.kind === 'bundle'
        ? launch.entry
        : launch.startScript
  const nodeExec = resolveAgentNodeExecPath(process.execPath, {
    packaged: app.isPackaged,
  })
  const electronNode = nodeExec === process.execPath
  const nodeEnv = electronNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
  const launchHeader =
    `[desktop] agent launch kind=${launch.kind} entry=${launchEntry}` +
    ` node=${nodeExec}` +
    (workspace ? ` workspace=${workspace}` : '')
  process.stderr.write(`${launchHeader}\n`)

  if (launch.kind === 'native') {
    agentProc = spawn(launch.entry, [], {
      cwd: appRoot,
      env,
      stdio: 'pipe',
      windowsHide: true,
    })
  } else if (launch.kind === 'bundle') {
    agentProc = spawn(nodeExec, [launch.entry], {
      cwd: appRoot,
      env: nodeEnv,
      stdio: 'pipe',
      windowsHide: true,
    })
  } else {
    agentProc = spawn(nodeExec, [launch.tsxCli, launch.startScript], {
      cwd: appRoot,
      env: nodeEnv,
      stdio: 'pipe',
      windowsHide: true,
    })
  }

  pipeAgentLogs(agentProc, launchHeader)

  agentProc.on('exit', (code, signal) => {
    if (
      !app.isQuitting &&
      !factoryResetInProgress &&
      code !== 0 &&
      code !== null
    ) {
      const logPath = getAgentLogPath()
      dialog.showErrorBox(
        'Agent stopped',
        `The coding agent server exited unexpectedly (code ${code ?? signal}).\n\n` +
          `See log:\n${logPath}`,
      )
      app.quit()
    }
  })
}

function stopAgent() {
  if (!agentProc || agentProc.killed) return Promise.resolve()
  const proc = agentProc
  agentProc = null
  const pid = proc.pid

  return new Promise(resolve => {
    const forceTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && pid) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
        } else {
          proc.kill('SIGKILL')
        }
      } catch {
        // Process already gone.
      }
      resolve()
    }, 5_000)

    proc.once('exit', () => {
      clearTimeout(forceTimer)
      resolve()
    })

    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(forceTimer)
      resolve()
    }
  })
}

function waitForHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  const url = `${getAgentUrl()}/health`

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, res => {
        res.resume()
        if (res.statusCode === 200) {
          resolve()
          return
        }
        schedule()
      })
      req.on('error', schedule)
      req.setTimeout(2_000, () => {
        req.destroy()
        schedule()
      })
    }

    const schedule = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Agent did not become healthy at ${url}`))
        return
      }
      setTimeout(attempt, 300)
    }

    attempt()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 500,
    minHeight: 560,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadURL(getAgentUrl())

  if (!app.isPackaged && process.env.DESKTOP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function ensureWebBuild() {
  const indexHtml = path.join(getWebDistDir(), 'index.html')
  if (fs.existsSync(indexHtml)) return

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Quit', 'Continue anyway'],
    defaultId: 0,
    title: 'Web build missing',
    message: 'web/dist was not found.',
    detail:
      'Run `npm run build:web` first so the agent can serve the UI.\n\n' +
      'You can still use the API at /health, but the window will be blank.',
  })

  if (response === 0) {
    app.quit()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    agentPort = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10)

    await ensureWebBuild()
    startAgent()

    try {
      await waitForHealth()
    } catch (err) {
      await stopAgent()
      dialog.showErrorBox(
        'Failed to start',
        `${err.message}\n\nIf port ${agentPort} is in use, free the port or set PORT.`,
      )
      app.quit()
      return
    }

    createWindow()
  })

  app.on('before-quit', event => {
    if (agentStopDone) return
    event.preventDefault()
    app.isQuitting = true
    void stopAgent().finally(() => {
      agentStopDone = true
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && agentProc) {
      createWindow()
    }
  })
}

ipcMain.handle('pick-workspace', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled) return null
  return filePaths[0] ?? null
})

ipcMain.handle('get-agent-url', () => getAgentUrl())

ipcMain.handle('factory-reset', async (_event, confirmation) => {
  if (confirmation !== 'RESET') {
    throw new Error('Type RESET to confirm')
  }
  if (factoryResetInProgress) {
    throw new Error('Factory reset already in progress')
  }

  factoryResetInProgress = true
  const homeDir = app.getPath('home')
  const dataRoot = assertSafeDesktopDataRoot(
    resolveDesktopDataRoot(homeDir, process.env),
    homeDir,
  )
  const tombstone = path.join(
    homeDir,
    `.${path.basename(dataRoot)}.reset-${Date.now()}-${process.pid}`,
  )

  try {
    mainWindow?.setEnabled?.(false)
    await stopAgent()
    await electronSession.defaultSession.clearStorageData()
    await electronSession.defaultSession.clearCache()

    if (fs.existsSync(dataRoot)) {
      fs.renameSync(dataRoot, tombstone)
      try {
        fs.rmSync(tombstone, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        })
      } catch (err) {
        if (!fs.existsSync(dataRoot) && fs.existsSync(tombstone)) {
          fs.renameSync(tombstone, dataRoot)
        }
        throw err
      }
    }

    app.relaunch()
    agentStopDone = true
    app.isQuitting = true
    app.exit(0)
    return { ok: true }
  } catch (err) {
    factoryResetInProgress = false
    mainWindow?.setEnabled?.(true)
    if (!agentProc) {
      startAgent()
      await waitForHealth().catch(() => {})
    }
    throw err
  }
})
