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
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { substituteArguments } from './argumentSubstitution.js'
import {
  resolveBashExecutable,
  resolvePowerShellExecutable,
} from '../core/shell/windows-paths.js'

const execFileAsync = promisify(execFile)

const SHELL_TIMEOUT_MS = 15_000
const SHELL_MAX_BUFFER = 200_000
const FILE_MAX_BYTES = 100_000

export type DirectiveRuntime = Pick<
  ExecutionBackend,
  'exec' | 'readText' | 'resolve' | 'assertInWorkspace'
>

export interface DirectiveArguments {
  rawArgs: string
  argumentNames: string[]
}

/**
 * Run a shell command capturing stdout, with the usual safety belts.
 * Returns a single string with stdout, or an `[error: ...]` marker on
 * failure / timeout — we DELIBERATELY do not throw, because killing the
 * whole slash-command expansion over one bad `!`-block is worse than
 * inlining the failure for the model to see.
 */
async function runLocalInlineShell(cmd: string, cwd: string): Promise<string> {
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

function boundedOutput(raw: string, maxBytes: number): string {
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.byteLength <= maxBytes) return raw
  return (
    bytes.subarray(0, maxBytes).toString('utf8') +
    `\n[…truncated; output exceeded ${maxBytes} bytes]`
  )
}

async function runBackendInlineShell(
  cmd: string,
  cwd: string,
  runtime: DirectiveRuntime,
): Promise<string> {
  try {
    const result = await runtime.exec(cmd, {
      cwd,
      timeoutMs: SHELL_TIMEOUT_MS,
    })
    if (result.timedOut) {
      return `[error: !\`${cmd}\` exceeded ${SHELL_TIMEOUT_MS}ms timeout]`
    }
    const stdout = boundedOutput(result.stdout, SHELL_MAX_BUFFER).trimEnd()
    if (result.code === 0 && !result.interrupted) return stdout

    const detail = result.interrupted
      ? 'interrupted'
      : result.stderr.trim() ||
        (result.code === null
          ? 'execution ended without an exit code'
          : `exited with code ${result.code}`)
    const marker = `[error: !\`${cmd}\` failed: ${detail}]`
    return stdout ? `${stdout}\n${marker}` : marker
  } catch (error) {
    return `[error: !\`${cmd}\` failed: ${error instanceof Error ? error.message : String(error)}]`
  }
}

async function runInlineShell(
  cmd: string,
  cwd: string,
  runtime?: DirectiveRuntime,
): Promise<string> {
  return runtime
    ? runBackendInlineShell(cmd, cwd, runtime)
    : runLocalInlineShell(cmd, cwd)
}

function truncateFile(raw: string, relPath: string): string {
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.byteLength <= FILE_MAX_BYTES) return raw
  return (
    bytes.subarray(0, FILE_MAX_BYTES).toString('utf8') +
    `\n\n[…truncated; @${relPath} exceeded ${FILE_MAX_BYTES} bytes]`
  )
}

async function inlineFile(
  relPath: string,
  cwd: string,
  runtime?: DirectiveRuntime,
): Promise<string> {
  // path.resolve — never path.join (win32 join(cwd, abs) concatenates).
  const abs = runtime
    ? runtime.resolve(cwd, relPath)
    : path.isAbsolute(relPath)
      ? path.normalize(relPath)
      : path.resolve(cwd, relPath)

  let raw: string
  try {
    if (runtime) {
      runtime.assertInWorkspace(cwd, abs, 'read')
      raw = await runtime.readText(abs)
    } else {
      raw = await fs.readFile(abs, 'utf-8')
    }
  } catch (e: unknown) {
    return `[error: @${relPath} could not be read: ${(e as Error).message}]`
  }

  raw = truncateFile(raw, relPath)

  const ext = path.extname(relPath).slice(1)
  // Wrap in a fenced code block so the model sees the boundary clearly.
  return `\n\`\`\`${ext}\n${raw}\n\`\`\`\n`
}

type DirectiveSpan = {
  type: 'shell' | 'file'
  start: number
  end: number
  value: string
}

/**
 * Find directives before argument substitution. This is the important trust
 * boundary: argument text and command output are never scanned a second time,
 * so neither can manufacture a new executable `!` or readable `@` directive.
 */
function findDirectiveSpans(template: string): DirectiveSpan[] {
  const spans: DirectiveSpan[] = []
  const shellRegex = /(^|[\s(<>])!`([^`\n]+)`/g
  for (const match of template.matchAll(shellRegex)) {
    const prefix = match[1] ?? ''
    const start = (match.index ?? 0) + prefix.length
    spans.push({
      type: 'shell',
      start,
      end: (match.index ?? 0) + match[0].length,
      value: match[2] ?? '',
    })
  }

  // Placeholder forms are accepted inside an authored path directive:
  // `@docs/$1.md`, `@$name`, and `@$ARGUMENTS[0]`.
  const fileRegex =
    /(^|[\s(])@((?:[-./\w\\]+|\$(?:ARGUMENTS(?:\[\d+\])?|[A-Za-z_][\w-]*|\d+))+)/g
  for (const match of template.matchAll(fileRegex)) {
    const prefix = match[1] ?? ''
    const start = (match.index ?? 0) + prefix.length
    const end = (match.index ?? 0) + match[0].length
    if (spans.some(span => start < span.end && end > span.start)) continue
    spans.push({ type: 'file', start, end, value: match[2] ?? '' })
  }

  return spans.sort((a, b) => a.start - b.start)
}

function shellQuote(value: string, runtime?: DirectiveRuntime): string {
  let powershell = false
  if (!runtime) {
    try {
      powershell = getDefaultShellKind() === 'powershell'
    } catch {
      // Let command execution report an unavailable shell. POSIX quoting is
      // the safest inert representation until then.
    }
  }
  return powershell
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'"'"'`)}'`
}

function substituteShellDirective(
  command: string,
  args: DirectiveArguments,
  runtime?: DirectiveRuntime,
): string {
  return substituteArguments(command, args.rawArgs, args.argumentNames, {
    token: value => shellQuote(value, runtime),
    raw: (_value, tokens) =>
      tokens.map(value => shellQuote(value, runtime)).join(' '),
  })
}

function literalPathValue(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('path arguments cannot contain NUL or newlines')
  }
  return value
}

function substitutePathDirective(
  filePath: string,
  args: DirectiveArguments,
): string {
  return substituteArguments(filePath, args.rawArgs, args.argumentNames, {
    token: literalPathValue,
    raw: (_value, tokens) => {
      if (tokens.length > 1) {
        throw new Error('a file directive accepts exactly one path argument')
      }
      return literalPathValue(tokens[0] ?? '')
    },
  })
}

async function expandDirectiveSpan(
  span: DirectiveSpan,
  cwd: string,
  runtime: DirectiveRuntime | undefined,
  args: DirectiveArguments | undefined,
): Promise<string> {
  try {
    if (span.type === 'shell') {
      const command = args
        ? substituteShellDirective(span.value, args, runtime)
        : span.value
      return await runInlineShell(command, cwd, runtime)
    }
    const filePath = args
      ? substitutePathDirective(span.value, args)
      : span.value
    return await inlineFile(filePath, cwd, runtime)
  } catch (error) {
    const source =
      span.type === 'shell' ? `!\`${span.value}\`` : `@${span.value}`
    return `[error: ${source} has invalid arguments: ${error instanceof Error ? error.message : String(error)}]`
  }
}

/**
 * Expand only directives that exist in the original template. Optional
 * arguments are substituted into normal text literally, into shell directives
 * as quoted argv values, and into file directives as one literal path.
 */
export async function expandInlineDirectives(
  template: string,
  cwd: string,
  runtime?: DirectiveRuntime,
  args?: DirectiveArguments,
): Promise<string> {
  const spans = findDirectiveSpans(template)
  const results = await Promise.all(
    spans.map(span => expandDirectiveSpan(span, cwd, runtime, args)),
  )
  const substituteText = (text: string) =>
    args ? substituteArguments(text, args.rawArgs, args.argumentNames) : text

  let cursor = 0
  let expanded = ''
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!
    expanded += substituteText(template.slice(cursor, span.start))
    expanded += results[i] ?? ''
    cursor = span.end
  }
  expanded += substituteText(template.slice(cursor))
  return expanded
}
