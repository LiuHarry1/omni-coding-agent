/**
 * Windows paths + shell binary resolution (Git Bash and powershell
 * detection).
 *
 * Bash trailers use POSIX paths; Node I/O uses native Windows paths.
 */
import { existsSync } from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'

const isWindows = process.platform === 'win32'

// ── Path conversion ──────────────────────────────────────────────────────────

/** `C:\Users\foo` → `/c/Users/foo`; UNC `\\server\share` → `//server/share`. */
export function windowsPathToPosixPath(windowsPath: string): string {
  if (windowsPath.startsWith('\\\\')) {
    return windowsPath.replace(/\\/g, '/')
  }
  const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (match) {
    const driveLetter = match[1]!.toLowerCase()
    return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
  }
  return windowsPath.replace(/\\/g, '/')
}

/**
 * `/c/Users/foo` → `C:\Users\foo`; also `/cygdrive/c/...` and `//server/share`.
 */
export function posixPathToWindowsPath(posixPath: string): string {
  if (posixPath.startsWith('//')) {
    return posixPath.replace(/\//g, '\\')
  }
  const cygdrive = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
  if (cygdrive) {
    const drive = cygdrive[1]!.toUpperCase()
    const rest = posixPath.slice(('/cygdrive/' + cygdrive[1]).length)
    return drive + ':' + (rest || '\\').replace(/\//g, '\\')
  }
  const drive = posixPath.match(/^\/([A-Za-z])(\/|$)/)
  if (drive) {
    const letter = drive[1]!.toUpperCase()
    const rest = posixPath.slice(2).replace(/\//g, '\\')
    return letter + ':' + (rest || '\\')
  }
  // Already Windows (`C:/Users/…`) or leftover MSYS (`/tmp` → `\tmp`).
  // Callers such as `readCwdAfter` realpath the result and ignore
  // conversions that do not exist on disk.
  return posixPath.replace(/\//g, '\\')
}

// ── Git Bash ─────────────────────────────────────────────────────────────────

let cachedGitBash: string | null | undefined

/**
 * Derive `bin\bash.exe` from a `git.exe` path.
 * `gitExe` must include the filename (`Git\cmd\git.exe`), not its dirname —
 * an extra `path.dirname` would resolve AppData installs to `Programs\bin`.
 */
export function bashExeFromGitExe(gitExe: string): string {
  return path.win32.join(gitExe, '..', '..', 'bin', 'bash.exe')
}

/**
 * Locate `git.exe`.
 * Prefers `Git\cmd\git.exe` (env-wrapped), never `mingw64\bin\git.exe`.
 */
function isUnsafeGitExe(gitExe: string): boolean {
  const normalized = path.resolve(gitExe).toLowerCase()
  const cwd = path.resolve(process.cwd()).toLowerCase()
  const sep = path.sep.toLowerCase()
  const pathDir = path.dirname(normalized)
  if (pathDir === cwd || normalized.startsWith(cwd + sep)) return true
  // Store alias — CreateProcess hangs waiting on the Microsoft Store.
  if (normalized.includes('\\windowsapps\\')) return true
  return false
}

function findGitExecutable(): string | null {
  const locations = [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  ]
  const localApp = process.env.LOCALAPPDATA?.trim()
  if (localApp) {
    locations.push(
      path.win32.join(localApp, 'Programs', 'Git', 'cmd', 'git.exe'),
    )
  }
  for (const location of locations) {
    if (existsSync(location)) return location
  }

  try {
    const r = spawnSync('where', ['git'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    })
    for (const gitExe of (r.stdout ?? '')
      .trim()
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)) {
      if (isUnsafeGitExe(gitExe)) continue
      return gitExe
    }
  } catch {
    // where.exe / git missing
  }
  return null
}

/**
 * Locate Git for Windows bash.exe.
 * Order: GIT_BASH_PATH → Program Files / %LOCALAPPDATA% `cmd\git.exe` → where git.
 * Returns null if missing — never fall back to System32/WSL bash.
 */
export function findGitBashPath(): string | null {
  if (!isWindows) return null
  if (cachedGitBash !== undefined) return cachedGitBash

  const fromEnv = process.env.GIT_BASH_PATH?.trim()
  if (fromEnv && existsSync(fromEnv)) {
    cachedGitBash = fromEnv
    return cachedGitBash
  }

  const gitPath = findGitExecutable()
  if (gitPath) {
    const bashPath = bashExeFromGitExe(gitPath)
    if (existsSync(bashPath)) {
      cachedGitBash = bashPath
      return cachedGitBash
    }
  }

  cachedGitBash = null
  return null
}

function pickUnixShell(): string {
  const userShell = process.env.SHELL
  if (userShell && /\/(bash|zsh|sh)$/.test(userShell)) return userShell
  return '/bin/bash'
}

/**
 * Bash binary for tool/worker spawn.
 * Windows: Git Bash only (throws if missing).
 */
export function resolveBashExecutable(): string {
  if (!isWindows) return pickUnixShell()
  const gitBash = findGitBashPath()
  if (!gitBash) {
    throw new Error(
      'Git Bash not found. Install Git for Windows (https://git-scm.com/downloads/win) ' +
        'or set GIT_BASH_PATH to bash.exe. Alternatively use the PowerShell tool.',
    )
  }
  return gitBash
}

// ── PowerShell ───────────────────────────────────────────────────────────────

let cachedPwsh: string | undefined

/** Prefer pwsh (PS 7+) when on PATH; else Windows PowerShell 5.1. Cached. */
export function resolvePowerShellExecutable(): string {
  if (!isWindows) return 'powershell.exe'
  if (cachedPwsh !== undefined) return cachedPwsh
  try {
    const r = spawnSync('where', ['pwsh'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const line = r.stdout?.trim().split(/\r?\n/)[0]
    if (line) {
      cachedPwsh = line
      return cachedPwsh
    }
  } catch {
    // ignore
  }
  cachedPwsh = 'powershell.exe'
  return cachedPwsh
}
