/**
 * Permission rules: `Tool` or `Tool(pattern)`.
 *
 * Path matching here serves the file tools (Read / Grep / Glob / LSP / Edit /
 * Write). Bash / PowerShell rules share the `Tool(content)` syntax and are
 * matched against commands in `tools/BashTool/bashPermissions.ts`.
 */
import ignore from 'ignore'
import * as os from 'os'
import * as path from 'path'
import {
  EDIT_FILE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LSP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { isPathInWorkspace } from '../workspace/workspace.js'

export type ParsedPermissionRule = {
  toolName: string
  ruleContent?: string
}

const READ_FAMILY = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  LSP_TOOL_NAME,
])

const WRITE_FAMILY = new Set([EDIT_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME])

/** Cache ignore instances by normalized pattern string. */
const ignoreCache = new Map<string, ReturnType<typeof ignore>>()

function unescapeRuleContent(raw: string): string {
  return raw.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

function findUnescapedChar(
  str: string,
  char: string,
  fromEnd: boolean,
): number {
  const start = fromEnd ? str.length - 1 : 0
  const step = fromEnd ? -1 : 1
  for (let i = start; fromEnd ? i >= 0 : i < str.length; i += step) {
    if (str[i] !== char) continue
    let backslashCount = 0
    let j = i - 1
    while (j >= 0 && str[j] === '\\') {
      backslashCount++
      j--
    }
    if (backslashCount % 2 === 0) return i
  }
  return -1
}

export function parsePermissionRule(ruleString: string): ParsedPermissionRule {
  const openParenIndex = findUnescapedChar(ruleString, '(', false)
  if (openParenIndex === -1) return { toolName: ruleString }

  const closeParenIndex = findUnescapedChar(ruleString, ')', true)
  if (
    closeParenIndex === -1 ||
    closeParenIndex <= openParenIndex ||
    closeParenIndex !== ruleString.length - 1
  ) {
    return { toolName: ruleString }
  }

  const toolName = ruleString.slice(0, openParenIndex)
  const rawContent = ruleString.slice(openParenIndex + 1, closeParenIndex)
  if (!toolName) return { toolName: ruleString }
  if (rawContent === '' || rawContent === '*') return { toolName }

  return { toolName, ruleContent: unescapeRuleContent(rawContent) }
}

export function ruleAppliesToTool(
  ruleTool: string,
  actualTool: string,
  access: 'read' | 'write',
): boolean {
  if (ruleTool === actualTool) return true
  if (
    access === 'read' &&
    ruleTool === FILE_READ_TOOL_NAME &&
    READ_FAMILY.has(actualTool)
  ) {
    return true
  }
  if (
    access === 'write' &&
    (ruleTool === EDIT_FILE_TOOL_NAME || ruleTool === WRITE_FILE_TOOL_NAME) &&
    WRITE_FAMILY.has(actualTool)
  ) {
    return true
  }
  return false
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function expandUserPath(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

function posixRelative(from: string, to: string): string | null {
  const rel = path.relative(path.resolve(from), path.resolve(to))
  if (!rel) return null
  const posix = toPosix(rel)
  if (posix === '..' || posix.startsWith('../')) return null
  return posix
}

function normalizeIgnorePattern(pattern: string): string | null {
  let pat = toPosix(pattern)
  if (pat.startsWith('./')) pat = pat.slice(2)
  if (pat.endsWith('/**')) pat = pat.slice(0, -3)
  return pat || null
}

function ignoreMatches(relativePosix: string, pattern: string): boolean {
  const pat = normalizeIgnorePattern(pattern)
  if (!pat || !relativePosix) return false
  try {
    let ig = ignoreCache.get(pat)
    if (!ig) {
      ig = ignore().add(pat)
      ignoreCache.set(pat, ig)
    }
    return ig.ignores(relativePosix)
  } catch {
    return false
  }
}

function absolutePatternMatches(absPath: string, pattern: string): boolean {
  let pat = expandUserPath(pattern)
  const wildcard = /[/\\]\*\*$/.test(pat)
  if (wildcard) pat = pat.replace(/[/\\]\*\*$/, '')
  const resolvedPat = path.resolve(pat)
  const resolvedFile = path.resolve(absPath)
  if (
    toPosix(resolvedFile).toLowerCase() === toPosix(resolvedPat).toLowerCase()
  ) {
    return true
  }
  return isPathInWorkspace(resolvedFile, resolvedPat)
}

/**
 * A single leading `/` is relative to the settings/project root
 * (`Read(/src/**)`), not the filesystem root. True absolutes: `~/`,
 * Windows drive (`C:\`), UNC (`//` / `\\`).
 */
export function isFilesystemAbsolutePattern(pattern: string): boolean {
  const expanded = expandUserPath(pattern)
  if (expanded.startsWith('~/') || expanded === '~') return true
  if (expanded.startsWith('//') || expanded.startsWith('\\\\')) return true
  if (/^[a-zA-Z]:[\\/]/.test(expanded)) return true
  // Lone leading `/foo` is project-relative, not FS-absolute.
  if (expanded.startsWith('/') && !expanded.startsWith('//')) return false
  return path.isAbsolute(expanded)
}

export function patternMatchesPath(
  absPath: string,
  pattern: string,
  relativeRoots: string[],
): boolean {
  const expanded = expandUserPath(pattern)
  if (isFilesystemAbsolutePattern(expanded)) {
    return absolutePatternMatches(absPath, expanded)
  }
  // Project-root-relative: strip one leading slash for ignore matching.
  let relativePat = expanded
  if (relativePat.startsWith('/') && !relativePat.startsWith('//')) {
    relativePat = relativePat.slice(1)
  }
  const resolvedFile = path.resolve(absPath)
  for (const root of relativeRoots) {
    const rel = posixRelative(root, resolvedFile)
    if (rel && ignoreMatches(rel, relativePat)) return true
  }
  return false
}

export function matchingPermissionRule(
  absPath: string,
  rules: string[],
  actualTool: string,
  access: 'read' | 'write',
  relativeRoots: string[],
): string | null {
  for (const ruleStr of rules) {
    const rule = parsePermissionRule(ruleStr)
    if (!ruleAppliesToTool(rule.toolName, actualTool, access)) continue
    if (!rule.ruleContent) return ruleStr
    if (patternMatchesPath(absPath, rule.ruleContent, relativeRoots)) {
      return ruleStr
    }
  }
  return null
}
