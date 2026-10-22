/**
 * Inline expansions inside a slash-command body:
 *
 *   1. !`<command>`     — shell out, replace with stdout (timeout-bounded).
 *                         Inline form. Useful for `!`git status`` style
 *                         context injection.
 *
 *   2. @path/to/file    — read file, replace with its content fenced in
 *                         markdown. Path is resolved relative to `cwd`.
 *
 * Slash commands are user-initiated and trusted.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { isWindows } from '../core/platform.js'
import { getDefaultShellKind } from '../core/shell/shell-utils.js'
import {
  resolveBashExecutable,
  resolvePowerShellExecutable,
} from '../core/shell/windows-paths.js'

const execFileAsync = promisify(execFile)

const SHELL_TIMEOUT_MS = 15_000
const SHELL_MAX_BUFFER = 200_000
const FILE_MAX_BYTES = 100_000

/**
 * Run a shell command capturing stdout, with the usual safety belts.
 * Returns a single string with stdout, or an `[error: ...]` marker on
 * failure / timeout — we DELIBERATELY do not throw, because killing the
 * whole slash-command expansion over one bad `!`-block is worse than
 * inlining the failure for the model to see.
 */
async function runInlineShell(cmd: string, cwd: string): Promise<string> {
  let exe: string
  let args: string[]
  try {
    const shell = getDefaultShellKind()
    if (shell === 'powershell') {
      exe = resolvePowerShellExecutable()
      args = ['-NoProfile', '-NonInteractive', '-Command', cmd]
    } else {
      exe = isWindows ? resolveBashExecutable() : 'sh'
      args = ['-c', cmd]
    }
  } catch (err) {
    return `[error: ${err instanceof Error ? err.message : String(err)}]`
  }

  try {
    const { stdout } = await execFileAsync(exe, args, {
      cwd,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: SHELL_MAX_BUFFER,
      windowsHide: true,
    })
    return stdout.trimEnd()
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string
      signal?: string
      killed?: boolean
    }
    if (err.signal === 'SIGTERM' || err.killed === true) {
      return `[error: !\`${cmd}\` exceeded ${SHELL_TIMEOUT_MS}ms timeout]`
    }
    const stdout = (err.stdout ?? '').toString().trimEnd()
    return stdout
      ? `${stdout}\n[error: !\`${cmd}\` failed: ${err.message}]`
      : `[error: !\`${cmd}\` failed: ${err.message}]`
  }
}

async function inlineFile(relPath: string, cwd: string): Promise<string> {
  // path.resolve — never path.join (win32 join(cwd, abs) concatenates).
  const abs = path.isAbsolute(relPath)
    ? path.normalize(relPath)
    : path.resolve(cwd, relPath)

  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf-8')
  } catch (e: unknown) {
    return `[error: @${relPath} could not be read: ${(e as Error).message}]`
  }

  if (Buffer.byteLength(raw, 'utf-8') > FILE_MAX_BYTES) {
    raw =
      raw.slice(0, FILE_MAX_BYTES) +
      `\n\n[…truncated; @${relPath} exceeded ${FILE_MAX_BYTES} bytes]`
  }

  const ext = path.extname(relPath).slice(1)
  // Wrap in a fenced code block so the model sees the boundary clearly.
  return `\n\`\`\`${ext}\n${raw}\n\`\`\`\n`
}

/**
 * Replace all `!\`cmd\`` blocks with their stdout, and all `@path`
 * references with the file's contents.
 *
 * `!`-blocks are run concurrently (they're independent). `@`-files are
 * also resolved concurrently. The order in the output preserves the
 * original positions in `template`.
 */
export async function expandInlineDirectives(
  template: string,
  cwd: string,
): Promise<string> {
  // ── 1. !`cmd` ──
  // Pattern: an unescaped `!` immediately followed by a backtick-quoted
  // command. We require the `!` to be at start-of-string, after whitespace,
  // or after common punctuation — otherwise expressions like `foo!\`bar\``
  // (someone using `!` as a typographic punctuation in prose) trigger.
  const shellRegex = /(^|[\s(<>])!`([^`\n]+)`/g
  const shellMatches = [...template.matchAll(shellRegex)]
  const shellResults = await Promise.all(
    shellMatches.map(m => runInlineShell(m[2] ?? '', cwd)),
  )
  let cursor = 0
  let withShell = ''
  for (let i = 0; i < shellMatches.length; i++) {
    const m = shellMatches[i]!
    const start = m.index ?? 0
    const prefix = m[1] ?? ''
    withShell +=
      template.slice(cursor, start) + prefix + (shellResults[i] ?? '')
    cursor = start + m[0].length
  }
  withShell += template.slice(cursor)

  // ── 2. @path ──
  // Match @ followed by a path-ish token. We're permissive but stop at
  // whitespace, quote, or common sentence punctuation. Email addresses
  // (something@host) are spared by requiring the `@` to be at start or
  // after whitespace / `(`.
  const fileRegex = /(^|[\s(])@([./\w][-\w./\\]*)/g
  const fileMatches = [...withShell.matchAll(fileRegex)]
  const fileResults = await Promise.all(
    fileMatches.map(m => inlineFile(m[2] ?? '', cwd)),
  )
  cursor = 0
  let withFiles = ''
  for (let i = 0; i < fileMatches.length; i++) {
    const m = fileMatches[i]!
    const start = m.index ?? 0
    const prefix = m[1] ?? ''
    withFiles +=
      withShell.slice(cursor, start) + prefix + (fileResults[i] ?? '')
    cursor = start + m[0].length
  }
  withFiles += withShell.slice(cursor)

  return withFiles
}
