/**
 * Filesystem permission check.
 *
 * Resolve is separate (always succeeds for valid paths). This module decides
 * allow / ask / deny. `dontAsk` (SSO) maps remaining ask → deny in canUseTool.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  EDIT_FILE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
} from '../../constants/tool_names.js'
import {
  isReadableInternalPath,
  getProjectsRoot,
  getBrowserLogsDir,
  getChatUploadsRoot,
} from '../../core/session-paths.js'
import { getDefaultPlansDirectory } from '../plans.js'
import { isPathInWorkspace } from '../../core/workspace.js'
import { normalizeWorkspacePath } from '../../core/workspace-path.js'
import { resolvePath } from '../../tools/utils.js'
import { matchingPermissionRule } from './permission-rules.js'
import { isAgentMemoryPath } from '../../tools/AgentTool/agentMemory.js'
import { isAuthEnabled } from '../env.js'

/** Settings values that actually change filesystem behavior. */
export const PERMISSION_DEFAULT_MODES = [
  'default',
  'dontAsk',
  'bypassPermissions',
] as const

/** `permissions.defaultMode` (settings.json) — implemented subset. */
export type PermissionDefaultMode = (typeof PERMISSION_DEFAULT_MODES)[number]

/** Runtime File-tool path policy derived from AUTH + defaultMode. */
export type FilesystemPermissionMode =
  'default' | 'dontAsk' | 'bypassPermissions'

export type FsPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'ask'; message: string; path: string }
  | { behavior: 'deny'; message: string }

/** A shell command that needs someone's approval before it runs. */
export type CommandPermissionAsk = {
  behavior: 'ask'
  message: string
  command: string
  /** Rules "Always allow" would add. Empty when no rule describes the command. */
  rules: string[]
  /**
   * What happens when nobody can be asked (`dontAsk`, scheduled turns).
   * A rule that says "ask" refuses; a command no rule mentions runs, as it
   * did before command rules existed.
   */
  whenUnattended: 'allow' | 'deny'
}

/** What a tool's `checkPermissions` may return. */
export type ToolPermissionDecision = FsPermissionDecision | CommandPermissionAsk

export interface FilesystemPermissionContext {
  mode: FilesystemPermissionMode
  /** Primary working directory (project cwd / pinned user workspace). */
  root: string
  extraReadRoots: string[]
  extraWriteRoots: string[]
  /** Session “Always allow” directories. */
  additionalWorkingDirectories: string[]
  /** `permissions.allow` — File-tool rules. Ignored under dontAsk. */
  allow: string[]
  /** `permissions.deny` — File-tool and shell rules. Always applied. */
  deny: string[]
  /** `permissions.ask` — shell rules that always ask. Always applied. */
  ask: string[]
}

/**
 * Extra roots readable outside the workspace.
 * Prefers `PERMISSION_EXTRA_READ_ROOTS`; falls back to deprecated
 * `SANDBOX_EXTRA_READ_ROOTS`.
 */
function parseExtraReadRoots(): string[] {
  const raw =
    process.env.PERMISSION_EXTRA_READ_ROOTS?.trim() ||
    process.env.SANDBOX_EXTRA_READ_ROOTS?.trim() ||
    ''
  if (!raw) return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => path.resolve(p))
}

export function resolveFilesystemPermissionMode(): FilesystemPermissionMode {
  return isAuthEnabled() ? 'dontAsk' : 'default'
}

export function filesystemModeFromDefaultMode(
  defaultMode?: PermissionDefaultMode | string,
): FilesystemPermissionMode {
  if (isAuthEnabled()) return 'dontAsk'
  if (defaultMode === 'dontAsk') return 'dontAsk'
  if (defaultMode === 'bypassPermissions') return 'bypassPermissions'
  // Legacy acceptEdits / plan (and anything else) → default
  return 'default'
}

export type CreateFilesystemPermissionContextOptions = {
  extraReadRoots?: string[]
  extraWriteRoots?: string[]
  additionalWorkingDirectories?: string[]
  allow?: string[]
  deny?: string[]
  ask?: string[]
  /** Override AUTH-derived mode (e.g. `permissions.defaultMode`). */
  mode?: FilesystemPermissionMode
}

export type SettingsPermissions = {
  additionalDirectories?: string[]
  allow?: string[]
  deny?: string[]
  ask?: string[]
  defaultMode?: PermissionDefaultMode
}

/**
 * Settings → context opts.
 * SSO (`AUTH_ENABLED`) ignores additionalDirectories and allow.
 * Desktop `defaultMode: dontAsk` keeps additionalDirectories (extra working
 * trees) but still maps remaining outside paths to deny.
 */
export function settingsPermissionOpts(
  permissions?: SettingsPermissions,
): Pick<
  CreateFilesystemPermissionContextOptions,
  'additionalWorkingDirectories' | 'allow' | 'deny' | 'ask' | 'mode'
> {
  const auth = isAuthEnabled()
  const mode = filesystemModeFromDefaultMode(permissions?.defaultMode)
  return {
    mode,
    additionalWorkingDirectories: auth
      ? []
      : (permissions?.additionalDirectories ?? []),
    allow: mode === 'dontAsk' ? [] : (permissions?.allow ?? []),
    deny: permissions?.deny ?? [],
    ask: permissions?.ask ?? [],
  }
}

export function createFilesystemPermissionContext(
  root: string,
  opts?: CreateFilesystemPermissionContextOptions,
): FilesystemPermissionContext {
  const plansRoot = path.resolve(getDefaultPlansDirectory())
  const extraReads = [
    path.resolve(getProjectsRoot()),
    path.resolve(getBrowserLogsDir()),
    path.resolve(getChatUploadsRoot()),
    plansRoot,
    ...parseExtraReadRoots(),
    ...(opts?.extraReadRoots ?? []).map(p => path.resolve(p)),
  ]
  return {
    mode: opts?.mode ?? resolveFilesystemPermissionMode(),
    root: path.resolve(root),
    extraReadRoots: extraReads,
    extraWriteRoots: [
      plansRoot,
      ...(opts?.extraWriteRoots ?? []).map(p => path.resolve(p)),
    ],
    additionalWorkingDirectories: (
      opts?.additionalWorkingDirectories ?? []
    ).map(p => {
      const resolved = resolvePath(root, p)
      return 'error' in resolved ? path.resolve(p) : resolved.abs
    }),
    allow: [...(opts?.allow ?? [])],
    deny: [...(opts?.deny ?? [])],
    ask: [...(opts?.ask ?? [])],
  }
}

export function workingDirectories(ctx: FilesystemPermissionContext): string[] {
  return [ctx.root, ...ctx.additionalWorkingDirectories]
}

function isUnderAnyRoot(absPath: string, roots: string[]): boolean {
  return roots.some(r => isPathInWorkspace(absPath, r))
}

/**
 * Original path plus symlink-resolved path (and nearest existing ancestor
 * when the leaf does not exist yet).
 */
export function getPathsForPermissionCheck(absPath: string): string[] {
  const resolved = path.resolve(absPath)
  const out = new Set<string>([resolved])
  try {
    out.add(path.resolve(fs.realpathSync(resolved)))
    return [...out]
  } catch {
    let dir = path.dirname(resolved)
    for (let i = 0; i < 32; i++) {
      try {
        const realDir = fs.realpathSync(dir)
        const rest = path.relative(dir, resolved)
        out.add(path.resolve(realDir, rest))
        break
      } catch {
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return [...out]
  }
}

function allowRoots(
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
): string[] {
  const extras = access === 'read' ? ctx.extraReadRoots : ctx.extraWriteRoots
  return [...workingDirectories(ctx), ...extras]
}

function allPathsAllowed(
  pathsToCheck: string[],
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
): boolean {
  const roots = allowRoots(ctx, access)
  return pathsToCheck.every(p => {
    if (isUnderAnyRoot(p, roots)) return true
    return access === 'read' && isReadableInternalPath(p)
  })
}

function askMessage(absPath: string, access: 'read' | 'write'): string {
  const verb = access === 'read' ? 'read from' : 'write to'
  return `Permission needed to ${verb} ${absPath}.`
}

function denyMessage(absPath: string, access: 'read' | 'write'): string {
  const verb = access === 'read' ? 'read' : 'write'
  return `Permission to ${verb} ${absPath} has been denied.`
}

function ruleRelativeRoots(ctx: FilesystemPermissionContext): string[] {
  return [...new Set(workingDirectories(ctx))]
}

function deniedByRule(
  pathsToCheck: string[],
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
  toolName: string,
): boolean {
  const roots = ruleRelativeRoots(ctx)
  return pathsToCheck.some(
    p => matchingPermissionRule(p, ctx.deny, toolName, access, roots) !== null,
  )
}

function allowedByRule(
  pathsToCheck: string[],
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
  toolName: string,
): boolean {
  if (ctx.mode === 'dontAsk') return false
  if (ctx.allow.length === 0) return false
  const roots = ruleRelativeRoots(ctx)
  return pathsToCheck.some(
    p => matchingPermissionRule(p, ctx.allow, toolName, access, roots) !== null,
  )
}

export function checkReadPermission(
  absPath: string,
  ctx: FilesystemPermissionContext,
  toolName: string = FILE_READ_TOOL_NAME,
): FsPermissionDecision {
  const abs = path.resolve(absPath)
  const pathsToCheck = getPathsForPermissionCheck(abs)
  if (deniedByRule(pathsToCheck, ctx, 'read', toolName)) {
    return { behavior: 'deny', message: denyMessage(abs, 'read') }
  }
  if (ctx.mode === 'bypassPermissions') return { behavior: 'allow' }
  // Agent memory directories (any scope) — isAgentMemoryPath carve-out.
  if (pathsToCheck.some(p => isAgentMemoryPath(p, ctx.root))) {
    return { behavior: 'allow' }
  }
  if (allPathsAllowed(pathsToCheck, ctx, 'read')) return { behavior: 'allow' }
  if (allowedByRule(pathsToCheck, ctx, 'read', toolName)) {
    return { behavior: 'allow' }
  }
  return { behavior: 'ask', message: askMessage(abs, 'read'), path: abs }
}

export function checkWritePermission(
  absPath: string,
  ctx: FilesystemPermissionContext,
  toolName: string = EDIT_FILE_TOOL_NAME,
): FsPermissionDecision {
  const abs = path.resolve(absPath)
  const pathsToCheck = getPathsForPermissionCheck(abs)
  if (deniedByRule(pathsToCheck, ctx, 'write', toolName)) {
    return { behavior: 'deny', message: denyMessage(abs, 'write') }
  }
  if (ctx.mode === 'bypassPermissions') return { behavior: 'allow' }
  // Agent memory directories (any scope) — isAgentMemoryPath carve-out.
  if (pathsToCheck.some(p => isAgentMemoryPath(p, ctx.root))) {
    return { behavior: 'allow' }
  }
  if (allPathsAllowed(pathsToCheck, ctx, 'write')) return { behavior: 'allow' }
  if (allowedByRule(pathsToCheck, ctx, 'write', toolName)) {
    return { behavior: 'allow' }
  }
  return { behavior: 'ask', message: askMessage(abs, 'write'), path: abs }
}

function refusalMessage(
  absPath: string,
  root: string,
  access: 'read' | 'write',
): string {
  const verb = access === 'read' ? 'Access' : 'Writes'
  return (
    `Refused: "${absPath}" is outside the workspace "${root}". ` +
    `${verb} are limited to your workspace.`
  )
}

/**
 * Execute-time / HTTP gate.
 * - deny → always refuse
 * - ask → refuse only in `dontAsk` (desktop may have just Allow'd via UI)
 * - allow → ok
 */
export function enforcePermissionAtExecute(
  absPath: string,
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
): void {
  const abs = path.resolve(absPath)
  for (const p of getPathsForPermissionCheck(abs)) {
    const decision =
      access === 'read'
        ? checkReadPermission(p, ctx)
        : checkWritePermission(p, ctx)
    if (decision.behavior === 'allow') continue
    if (decision.behavior === 'deny') throw new Error(decision.message)
    if (ctx.mode === 'dontAsk') {
      throw new Error(refusalMessage(p, ctx.root, access))
    }
  }
}

/** @deprecated Prefer enforcePermissionAtExecute — same behavior. */
export function assertAccessible(
  absPath: string,
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
): void {
  enforcePermissionAtExecute(absPath, ctx, access)
}

export function assertAccessibleResolved(
  absPath: string,
  ctx: FilesystemPermissionContext,
  access: 'read' | 'write',
): void {
  enforcePermissionAtExecute(absPath, ctx, access)
}

export function policyFromContext(
  cwd: string,
  permissionContext?: FilesystemPermissionContext,
): FilesystemPermissionContext {
  return permissionContext ?? createFilesystemPermissionContext(cwd)
}

export function workspaceBoundaryPromptSection(
  cwd: string,
  mode: FilesystemPermissionMode = resolveFilesystemPermissionMode(),
): string {
  if (mode !== 'dontAsk') return ''
  const root = normalizeWorkspacePath(cwd)
  return `
# Workspace boundary (enforced)
 - Your only project directory is: ${root}
 - Do NOT list, read, search, or modify files outside this directory (including sibling directories under the parent path, or other users' workspaces).
 - If a path is outside this directory, stop and work only within ${root}.
 - System binaries (git, python, npm, etc.) may still be executed via the shell; only file data outside the workspace is off-limits.
`
}

export function addAlwaysAllowDirectory(
  ctx: FilesystemPermissionContext,
  absPath: string,
): string {
  let dir = path.resolve(absPath)
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
      dir = path.dirname(dir)
    }
  } catch {
    dir = path.dirname(dir)
  }
  if (!ctx.additionalWorkingDirectories.some(r => isPathInWorkspace(dir, r))) {
    ctx.additionalWorkingDirectories.push(dir)
  }
  return dir
}

export function filePathFromInput(
  input: unknown,
  keys: string[] = ['file_path', 'path'],
): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

function resolveInputPath(
  cwd: string,
  input: unknown,
  pathKeys: string[],
  defaultPath?: string,
): { abs: string } | { error: string } | { skip: true } {
  const raw = filePathFromInput(input, pathKeys) ?? defaultPath
  if (raw === undefined) return { skip: true }
  const resolved = resolvePath(cwd, raw)
  if ('error' in resolved) {
    return { error: resolved.error || 'Invalid path' }
  }
  return { abs: resolved.abs }
}

/** Resolve the input path, then checkRead. */
export function checkReadPermissionForTool(
  cwd: string,
  permissionContext: FilesystemPermissionContext | undefined,
  input: unknown,
  pathKeys: string[] = ['file_path', 'path'],
  defaultPath?: string,
  toolName: string = FILE_READ_TOOL_NAME,
): FsPermissionDecision {
  const resolved = resolveInputPath(cwd, input, pathKeys, defaultPath)
  if ('skip' in resolved) return { behavior: 'allow' }
  if ('error' in resolved) {
    return { behavior: 'deny', message: resolved.error }
  }
  return checkReadPermission(
    resolved.abs,
    policyFromContext(cwd, permissionContext),
    toolName,
  )
}

/** Resolve the input path, then checkWrite. */
export function checkWritePermissionForTool(
  cwd: string,
  permissionContext: FilesystemPermissionContext | undefined,
  input: unknown,
  pathKeys: string[] = ['file_path', 'path'],
  defaultPath?: string,
  toolName: string = EDIT_FILE_TOOL_NAME,
): FsPermissionDecision {
  const resolved = resolveInputPath(cwd, input, pathKeys, defaultPath)
  if ('skip' in resolved) return { behavior: 'allow' }
  if ('error' in resolved) {
    return { behavior: 'deny', message: resolved.error }
  }
  return checkWritePermission(
    resolved.abs,
    policyFromContext(cwd, permissionContext),
    toolName,
  )
}

export function denyOutsideMessage(
  absPath: string,
  root: string,
  access: 'read' | 'write',
): string {
  return refusalMessage(absPath, root, access)
}
