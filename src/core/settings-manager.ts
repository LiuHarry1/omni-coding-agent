import * as fs from 'fs'
import * as path from 'path'
import type { AppConfig, AutoMemoryConfig, MCPServerConfig } from './types.js'
import {
  DEFAULT_PROFILE,
  isModelTier,
  profileToRecord,
  resolveModelProfiles,
  type ModelProfiles,
  type ModelTier,
} from './llm/index.js'
import { loadPlugins } from './plugins/index.js'
import {
  getAppDirName,
  getUserAppDir,
  LOCAL_SETTINGS_FILE_NAME,
  SETTINGS_FILE_NAME,
} from '../utils/app-dir.js'
import {
  getManagedDir,
  getManagedSettingsDropInDir,
  getManagedSettingsPath,
} from '../utils/managed-path.js'
import type { SettingsFileJson } from './settings-schema.js'
import {
  validateSettingsFile,
  type ValidationError,
} from './settings-validation.js'

function defaultModels(): ModelProfiles {
  const large = { ...DEFAULT_PROFILE }
  return { large, medium: { ...large }, small: { ...large } }
}

export const DEFAULTS: AppConfig = {
  models: defaultModels(),
  compaction: {
    enabled: true,
    contextWindow: 200_000,
    microCompactKeepRecent: 5,
    maxFilesToRestore: 5,
    maxTokensPerFile: 5_000,
    fileBudget: 50_000,
    timeBasedMicroEnabled: false,
    timeBasedMicroGapMinutes: 5,
  },
  sessionMemory: {
    enabled: true,
    minimumTokensToInit: 10_000,
    minimumTokensBetweenUpdate: 5_000,
    toolCallsBetweenUpdates: 3,
    cacheSafe: true,
    modelTier: 'medium',
    compactMinTokens: 10_000,
    compactMaxTokens: 40_000,
    compactMinTextMessages: 5,
  },
  autoMemoryEnabled: true,
  mcpServers: {},
  lspServers: {},
  disabledTools: [],
  environments: { ssh: [] },
  scheduledTasks: { enabled: true },
  marketplaces: { providers: [] },
}

/** Code defaults for extract/prefetch (throttle default = 1). */
const AUTO_MEMORY_RUNTIME_DEFAULTS = {
  extractEveryNTurns: 1,
  cacheSafe: true,
  /** Used only when cacheSafe is false. */
  modelTier: 'medium' as const,
  prefetchEnabled: true,
  prefetchModelTier: 'small' as const,
} as const

/**
 * Resolve runtime AutoMemoryConfig from the compatibility flat fields
 * plus agent extensions under nested `autoMemory` (or legacy flat keys).
 *
 * Flat surface: autoMemoryEnabled / autoMemoryDirectory
 * Agent-only: autoMemory.cacheSafe / autoMemory.modelTier / prefetch*
 */
export function resolveAutoMemoryConfig(config: AppConfig): AutoMemoryConfig {
  const cacheSafe =
    typeof config.autoMemoryCacheSafe === 'boolean'
      ? config.autoMemoryCacheSafe
      : AUTO_MEMORY_RUNTIME_DEFAULTS.cacheSafe
  const modelTier: ModelTier = isModelTier(config.autoMemoryModelTier)
    ? config.autoMemoryModelTier
    : AUTO_MEMORY_RUNTIME_DEFAULTS.modelTier

  const nested = config.autoMemory

  const prefetchEnabled =
    typeof nested?.prefetchEnabled === 'boolean'
      ? nested.prefetchEnabled
      : AUTO_MEMORY_RUNTIME_DEFAULTS.prefetchEnabled

  const prefetchModelTier: ModelTier = isModelTier(nested?.prefetchModelTier)
    ? nested.prefetchModelTier
    : AUTO_MEMORY_RUNTIME_DEFAULTS.prefetchModelTier

  return {
    enabled: config.autoMemoryEnabled !== false,
    directory:
      config.autoMemoryDirectory ??
      (typeof nested?.directory === 'string' ? nested.directory : undefined),
    extractEveryNTurns: AUTO_MEMORY_RUNTIME_DEFAULTS.extractEveryNTurns,
    cacheSafe,
    modelTier,
    prefetchEnabled,
    prefetchModelTier,
  }
}

/** Writable scopes — excludes managed. */
export type WritableSettingsScope = 'user' | 'project' | 'local'

/** All settings sources including policy/managed. */
export type SettingsScope = WritableSettingsScope | 'managed'

export interface SettingsSource {
  scope: SettingsScope
  path: string
  exists: boolean
  applied: boolean
  error?: string
}

export interface ResolvedSettings {
  config: AppConfig
  /** Winning settings-file scope for each merged MCP server. */
  mcpSources: Record<string, SettingsScope>
  sources: SettingsSource[]
  validationErrors: ValidationError[]
  userDir: string
  projectDir: string
  userPath: string
  projectPath: string
  localPath: string
  managedDir: string
  managedPath: string
}

export interface EffectiveSettings extends ResolvedSettings {
  /** Plugin MCP merged with settings MCP (settings win on name collision). */
  effectiveMcpServers: Record<string, MCPServerConfig>
  /** Safe ownership/removal metadata for every effective MCP server. */
  mcpProvenance: Record<string, MCPServerProvenance>
}

export interface MCPServerProvenance {
  configuredBy: SettingsScope | 'plugin'
  writable: boolean
  writableScope?: WritableSettingsScope
}

export function validateMCPRemoval(
  provenance: Record<string, MCPServerProvenance>,
  name: string,
  scope: WritableSettingsScope,
): { status: 404 | 409; error: string } | null {
  const ownership = provenance[name]
  if (!ownership) return { status: 404, error: 'MCP server not found' }
  if (!ownership.writable || !ownership.writableScope) {
    return {
      status: 409,
      error: `MCP server '${name}' is provided by ${ownership.configuredBy} and is read-only`,
    }
  }
  if (ownership.writableScope !== scope) {
    return {
      status: 409,
      error: `MCP server '${name}' belongs to ${ownership.writableScope} scope, not ${scope}`,
    }
  }
  return null
}

type PartialAppConfig = SettingsFileJson

type ParsedSettingsFile = {
  settings: PartialAppConfig | null
  error?: string
  validationErrors?: ValidationError[]
}

/** path-keyed parse cache invalidated by resetSettingsCache(). */
const parseFileCache = new Map<
  string,
  { mtimeMs: number; parsed: ParsedSettingsFile }
>()

/** Per-cwd merged settings cache keyed by source-file mtimes. */
const resolvedCache = new Map<
  string,
  { mtimeKey: string; result: ResolvedSettings }
>()

function cloneDefaults(): AppConfig {
  return structuredClone(DEFAULTS)
}

export function resolveSettingsPaths(cwd: string): {
  userDir: string
  projectDir: string
  userPath: string
  projectPath: string
  localPath: string
  managedDir: string
  managedPath: string
} {
  const userDir = getUserAppDir()
  const projectDir = path.join(path.resolve(cwd), getAppDirName())
  const managedDir = getManagedDir()
  return {
    userDir,
    projectDir,
    userPath: path.join(userDir, SETTINGS_FILE_NAME),
    projectPath: path.join(projectDir, SETTINGS_FILE_NAME),
    localPath: path.join(projectDir, LOCAL_SETTINGS_FILE_NAME),
    managedDir,
    managedPath: getManagedSettingsPath(),
  }
}

/**
 * List managed settings files in load order: managed-settings.json first, then
 * managed-settings.d/*.json sorted alphabetically (drop-ins override base).
 * Used for mtime cache keys; prefer `loadManagedFileSettings` for merge.
 */
export function listManagedSettingsFiles(): string[] {
  const files: string[] = [getManagedSettingsPath()]
  const dropInDir = getManagedSettingsDropInDir()
  try {
    const names = fs
      .readdirSync(dropInDir, { withFileTypes: true })
      .filter(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
      .map(d => d.name)
      .sort()
    for (const name of names) {
      files.push(path.join(dropInDir, name))
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.warn(
        `[settings] managed drop-in dir read failed: ${(err as Error).message}`,
      )
    }
  }
  return files
}

/**
 * Merge base + drop-ins into one object.
 * Base first, then drop-ins alphabetically (later wins on key collision via
 * applyLayer semantics when applied as a single layer).
 */
export function loadManagedFileSettings(): {
  settings: PartialAppConfig | null
  errors: string[]
  validationErrors: ValidationError[]
  /** Files that contributed (for diagnostics / mtime). */
  files: string[]
} {
  const errors: string[] = []
  const validationErrors: ValidationError[] = []
  const files: string[] = []
  let merged: PartialAppConfig = {}
  let found = false

  for (const filePath of listManagedSettingsFiles()) {
    const {
      settings,
      error,
      validationErrors: fileErrors,
    } = readSettingsFile(filePath)
    if (error) {
      errors.push(`${filePath}: ${error}`)
      console.warn(`[settings] Failed to parse ${filePath}: ${error}`)
      continue
    }
    if (fileErrors?.length) {
      validationErrors.push(...fileErrors)
      console.warn(
        `[settings] Validation failed for ${filePath}: ${fileErrors.map(e => `${e.path}: ${e.message}`).join('; ')}`,
      )
      continue
    }
    if (!settings || Object.keys(settings).length === 0) continue
    files.push(filePath)
    merged = deepMergeSettingsLayer(merged, settings)
    found = true
  }

  return { settings: found ? merged : null, errors, validationErrors, files }
}

/** Merge two partial settings objects (drop-in over base). */
function deepMergeSettingsLayer(
  base: PartialAppConfig,
  overlay: PartialAppConfig,
): PartialAppConfig {
  const out: PartialAppConfig = { ...base, ...overlay }
  if (base.models || overlay.models) {
    out.models = {
      ...(base.models as object | undefined),
      ...(overlay.models as object | undefined),
    } as PartialAppConfig['models']
    for (const tier of ['large', 'medium', 'small'] as const) {
      const b = (base.models as Record<string, unknown> | undefined)?.[tier]
      const o = (overlay.models as Record<string, unknown> | undefined)?.[tier]
      if (b || o) {
        ;(out.models as Record<string, unknown>)[tier] = {
          ...((b as object) ?? {}),
          ...((o as object) ?? {}),
        }
      }
    }
  }
  if (base.mcpServers || overlay.mcpServers) {
    out.mcpServers = {
      ...(base.mcpServers ?? {}),
      ...(overlay.mcpServers ?? {}),
    }
  }
  if (base.lspServers || overlay.lspServers) {
    out.lspServers = {
      ...(base.lspServers ?? {}),
      ...(overlay.lspServers ?? {}),
    }
  }
  if (base.autoMemory || overlay.autoMemory) {
    out.autoMemory = {
      ...((base.autoMemory as object) ?? {}),
      ...((overlay.autoMemory as object) ?? {}),
    } as PartialAppConfig['autoMemory']
  }
  if (base.compaction || overlay.compaction) {
    out.compaction = {
      ...((base.compaction as object) ?? {}),
      ...((overlay.compaction as object) ?? {}),
    } as PartialAppConfig['compaction']
  }
  if (base.sessionMemory || overlay.sessionMemory) {
    out.sessionMemory = {
      ...((base.sessionMemory as object) ?? {}),
      ...((overlay.sessionMemory as object) ?? {}),
    } as PartialAppConfig['sessionMemory']
  }
  if (base.browser || overlay.browser) {
    out.browser = { ...(base.browser ?? {}), ...(overlay.browser ?? {}) }
  }
  if (base.scheduledTasks || overlay.scheduledTasks) {
    out.scheduledTasks = {
      ...(base.scheduledTasks ?? {}),
      ...(overlay.scheduledTasks ?? {}),
    }
  }
  if (base.marketplaces || overlay.marketplaces) {
    out.marketplaces = overlay.marketplaces ?? base.marketplaces
  }
  if (base.agents || overlay.agents) {
    const mergedPicker =
      base.agents?.picker || overlay.agents?.picker
        ? {
            ...(base.agents?.picker ?? {}),
            ...(overlay.agents?.picker ?? {}),
          }
        : undefined
    const mergedDefault =
      base.agents?.default || overlay.agents?.default
        ? {
            ...(base.agents?.default ?? {}),
            ...(overlay.agents?.default ?? {}),
          }
        : undefined
    out.agents = {
      ...(base.agents ?? {}),
      ...(overlay.agents ?? {}),
      ...(mergedPicker ? { picker: mergedPicker } : {}),
      ...(mergedDefault ? { default: mergedDefault } : {}),
    }
    if (!mergedPicker) delete out.agents.picker
    if (!mergedDefault) delete out.agents.default
  }
  if (base.permissions || overlay.permissions) {
    out.permissions = mergePermissionsConfig(
      base.permissions,
      overlay.permissions,
    )
  }
  if (base.disabledTools || overlay.disabledTools) {
    out.disabledTools = [
      ...new Set([
        ...(base.disabledTools ?? []),
        ...(overlay.disabledTools ?? []),
      ]),
    ]
  }
  return out
}

/**
 * Strip autoMemory directory overrides from untrusted scopes (project/local).
 */
function stripUntrustedAutoMemoryDirectory(
  settings: PartialAppConfig,
  sourcePath: string,
): PartialAppConfig {
  const next = { ...settings }
  if (next.autoMemoryDirectory !== undefined) {
    console.warn(
      `[settings] Ignoring autoMemoryDirectory from ${sourcePath} (trusted scopes only)`,
    )
    delete next.autoMemoryDirectory
  }
  if (
    next.autoMemory &&
    typeof next.autoMemory === 'object' &&
    'directory' in next.autoMemory
  ) {
    const { directory: _ignored, ...restAuto } = next.autoMemory as Record<
      string,
      unknown
    > & { directory?: unknown }
    if (_ignored !== undefined) {
      console.warn(
        `[settings] Ignoring autoMemory.directory from ${sourcePath} (trusted scopes only)`,
      )
    }
    next.autoMemory = restAuto
  }
  return next
}

/**
 * In authenticated multi-tenant deployments, only managed policy may define
 * server-side fetch targets. Local single-user mode trusts its own settings
 * files, including explicit allowInsecureHttp for intranet registries.
 */
function stripUntrustedMarketplaces(
  settings: PartialAppConfig,
  sourcePath: string,
): PartialAppConfig {
  if (!settings.marketplaces) return settings
  console.warn(
    `[settings] Ignoring marketplaces from ${sourcePath} (managed only when AUTH_ENABLED=true)`,
  )
  const next = { ...settings }
  delete next.marketplaces
  return next
}

function isAuthDeployment(): boolean {
  return (
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function settingsMtimeKey(filePaths: readonly string[]): string {
  return filePaths.map(p => `${p}:${fileMtimeMs(p)}`).join('|')
}

function readSettingsFile(filePath: string): ParsedSettingsFile {
  const mtimeMs = fileMtimeMs(filePath)
  const cached = parseFileCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.parsed

  let parsed: ParsedSettingsFile
  if (mtimeMs === 0) {
    parsed = { settings: null }
  } else {
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      if (text.trim() === '') {
        parsed = { settings: {} }
      } else {
        const json = JSON.parse(text)
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          parsed = {
            settings: null,
            error: 'settings file must contain a JSON object',
          }
        } else {
          const validated = validateSettingsFile(json, filePath)
          if (validated.errors.length > 0) {
            parsed = {
              settings: null,
              validationErrors: validated.errors,
            }
          } else {
            parsed = { settings: validated.settings ?? {} }
          }
        }
      }
    } catch (err) {
      parsed = { settings: null, error: (err as Error).message }
    }
  }

  parseFileCache.set(filePath, { mtimeMs, parsed })
  return parsed
}

/** reset on settings write (see changeDetector → resetSettingsCache). */
export function resetSettingsCache(): void {
  parseFileCache.clear()
  resolvedCache.clear()
}

function mergePermissionsConfig(
  base?: AppConfig['permissions'],
  overlay?: AppConfig['permissions'],
): AppConfig['permissions'] | undefined {
  if (!base && !overlay) return undefined
  const additionalDirectories = [
    ...new Set([
      ...(base?.additionalDirectories ?? []),
      ...(overlay?.additionalDirectories ?? []),
    ]),
  ]
  const allow = [
    ...new Set([...(base?.allow ?? []), ...(overlay?.allow ?? [])]),
  ]
  const deny = [...new Set([...(base?.deny ?? []), ...(overlay?.deny ?? [])])]
  const out: NonNullable<AppConfig['permissions']> = {
    ...(base ?? {}),
    ...(overlay ?? {}),
  }
  if (overlay?.defaultMode) out.defaultMode = overlay.defaultMode
  else if (base?.defaultMode) out.defaultMode = base.defaultMode
  if (additionalDirectories.length > 0) {
    out.additionalDirectories = additionalDirectories
  } else {
    delete out.additionalDirectories
  }
  if (allow.length > 0) out.allow = allow
  else delete out.allow
  if (deny.length > 0) out.deny = deny
  else delete out.deny
  return out
}

function mergeStringArray(
  current: readonly string[] | undefined,
  next: unknown[],
): string[] {
  const out = new Set(current ?? [])
  for (const value of next) {
    if (typeof value === 'string') out.add(value)
  }
  return [...out]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True when a tier was explicitly configured (not merely a fallback clone). */
function tierExplicitlySet(
  config: AppConfig,
  tier: 'medium' | 'small',
): boolean {
  // Heuristic: after resolve, fallback clones share the same model id + baseURL
  // as their parent. We track explicit tiers on a WeakMap-less side channel via
  // comparing to large after each layer is imperfect; instead we stash flags.
  return Boolean(
    (config as AppConfig & { _explicit?: Set<string> })._explicit?.has(tier),
  )
}

function markExplicit(config: AppConfig, tier: 'medium' | 'small'): void {
  const c = config as AppConfig & { _explicit?: Set<string> }
  if (!c._explicit) c._explicit = new Set()
  c._explicit.add(tier)
}

function applyLayer(config: AppConfig, layer: PartialAppConfig): void {
  const hasModels = isRecord(layer.models)
  if (hasModels) {
    const layerModels = layer.models as Record<string, unknown>
    if (isRecord(layerModels.medium)) markExplicit(config, 'medium')
    if (isRecord(layerModels.small)) markExplicit(config, 'small')

    // Only pass tiers that are being set this layer or were previously explicit,
    // so resolveModelProfiles can fall back medium/small → large.
    const modelsArg: Record<string, unknown> = {
      large: {
        ...profileToRecord(config.models.large),
        ...(isRecord(layerModels.large) ? layerModels.large : {}),
      },
    }
    if (isRecord(layerModels.medium) || tierExplicitlySet(config, 'medium')) {
      modelsArg.medium = {
        ...profileToRecord(config.models.medium),
        ...(isRecord(layerModels.medium) ? layerModels.medium : {}),
      }
    }
    if (isRecord(layerModels.small) || tierExplicitlySet(config, 'small')) {
      modelsArg.small = {
        ...profileToRecord(config.models.small),
        ...(isRecord(layerModels.small) ? layerModels.small : {}),
      }
    }

    config.models = resolveModelProfiles({ models: modelsArg })
  }

  if (layer.compaction && typeof layer.compaction === 'object') {
    Object.assign(config.compaction, layer.compaction)
  }

  if (layer.sessionMemory && typeof layer.sessionMemory === 'object') {
    Object.assign(config.sessionMemory, layer.sessionMemory)
  }

  // Prefer nested autoMemory.{enabled,directory,cacheSafe,modelTier}.
  // Flat autoMemoryEnabled / autoMemoryDirectory remain supported aliases;
  // flat autoMemoryCacheSafe / autoMemoryModelTier are legacy agent aliases.
  if (typeof layer.autoMemoryEnabled === 'boolean') {
    config.autoMemoryEnabled = layer.autoMemoryEnabled
  }
  if (typeof layer.autoMemoryDirectory === 'string') {
    config.autoMemoryDirectory = layer.autoMemoryDirectory
  }
  if (typeof layer.autoMemoryCacheSafe === 'boolean') {
    config.autoMemoryCacheSafe = layer.autoMemoryCacheSafe
  }
  if (isModelTier(layer.autoMemoryModelTier)) {
    config.autoMemoryModelTier = layer.autoMemoryModelTier
  }
  if (layer.autoMemory && typeof layer.autoMemory === 'object') {
    const nested = layer.autoMemory
    config.autoMemory = { ...config.autoMemory, ...nested }
    if (typeof nested.enabled === 'boolean') {
      config.autoMemoryEnabled = nested.enabled
    }
    if (typeof nested.directory === 'string') {
      config.autoMemoryDirectory = nested.directory
    }
    if (typeof nested.cacheSafe === 'boolean') {
      config.autoMemoryCacheSafe = nested.cacheSafe
    }
    if (isModelTier(nested.modelTier)) {
      config.autoMemoryModelTier = nested.modelTier
    }
  }

  if (layer.mcpServers && typeof layer.mcpServers === 'object') {
    config.mcpServers = {
      ...config.mcpServers,
      ...layer.mcpServers,
    }
  }

  if (layer.lspServers && typeof layer.lspServers === 'object') {
    config.lspServers = {
      ...config.lspServers,
      ...layer.lspServers,
    }
  }

  if (layer.browser && typeof layer.browser === 'object') {
    config.browser = { ...(config.browser ?? {}), ...layer.browser }
  }

  if (layer.scheduledTasks && typeof layer.scheduledTasks === 'object') {
    config.scheduledTasks = {
      ...(config.scheduledTasks ?? {}),
      ...layer.scheduledTasks,
    }
  }

  if (layer.marketplaces && typeof layer.marketplaces === 'object') {
    config.marketplaces = {
      providers: [...(layer.marketplaces.providers ?? [])],
    }
  }

  if (layer.agents && typeof layer.agents === 'object') {
    const nextPicker =
      config.agents?.picker || layer.agents.picker
        ? {
            ...(config.agents?.picker ?? {}),
            ...(layer.agents.picker ?? {}),
          }
        : undefined
    const nextDefault =
      config.agents?.default || layer.agents.default
        ? {
            ...(config.agents?.default ?? {}),
            ...(layer.agents.default ?? {}),
          }
        : undefined
    config.agents = {
      ...(config.agents ?? {}),
      ...layer.agents,
      ...(nextPicker ? { picker: nextPicker } : { picker: undefined }),
      ...(nextDefault ? { default: nextDefault } : { default: undefined }),
    }
    if (!nextPicker) delete config.agents.picker
    if (!nextDefault) delete config.agents.default
  }

  if (layer.permissions) {
    config.permissions = mergePermissionsConfig(
      config.permissions,
      layer.permissions,
    )
  }

  if (Array.isArray(layer.disabledTools)) {
    config.disabledTools = mergeStringArray(
      config.disabledTools,
      layer.disabledTools,
    )
  }

  if (layer.environments && typeof layer.environments === 'object') {
    const ssh = Array.isArray(layer.environments.ssh)
      ? layer.environments.ssh
      : []
    config.environments = {
      ...(config.environments ?? {}),
      ssh: ssh as NonNullable<AppConfig['environments']>['ssh'],
    }
  }
}

function applySettingsSource(
  config: AppConfig,
  source: SettingsSource,
  validationErrors: ValidationError[],
  mcpSources: Record<string, SettingsScope>,
): void {
  source.exists = fileMtimeMs(source.path) > 0
  const {
    settings,
    error,
    validationErrors: fileErrors,
  } = readSettingsFile(source.path)
  if (error) {
    source.error = error
    console.warn(`[settings] Failed to parse ${source.path}: ${error}`)
    return
  }
  if (fileErrors?.length) {
    validationErrors.push(...fileErrors)
    source.error = fileErrors.map(e => `${e.path}: ${e.message}`).join('; ')
    console.warn(
      `[settings] Validation failed for ${source.path}: ${source.error}`,
    )
    return
  }
  if (!settings) return

  let toApply: PartialAppConfig = settings
  if (source.scope === 'project' || source.scope === 'local') {
    toApply = stripUntrustedAutoMemoryDirectory(settings, source.path)
  }
  if (source.scope !== 'managed' && isAuthDeployment()) {
    toApply = stripUntrustedMarketplaces(toApply, source.path)
  }
  if (toApply.mcpServers && typeof toApply.mcpServers === 'object') {
    for (const name of Object.keys(toApply.mcpServers)) {
      mcpSources[name] = source.scope
    }
  }
  applyLayer(config, toApply)
  source.applied = true
  console.log(`[settings] Loaded ${source.scope} settings from ${source.path}`)
}

function resolveSettingsFromDisk(cwd: string): ResolvedSettings {
  const paths = resolveSettingsPaths(cwd)
  const config = cloneDefaults()
  const validationErrors: ValidationError[] = []
  const mcpSources: Record<string, SettingsScope> = {}
  // Merge order: user → project → local → flag → policy(managed last).
  // We have no flag layer; managed is policySettings.
  // SSO: cwd === agent home → userPath === projectPath; apply once as user
  // (trusted — may carry autoMemory.directory). Still load local separately.
  const sources: SettingsSource[] = []
  const sameUserProject = paths.userPath === paths.projectPath
  sources.push({
    scope: 'user',
    path: paths.userPath,
    exists: false,
    applied: false,
  })
  if (!sameUserProject) {
    sources.push({
      scope: 'project',
      path: paths.projectPath,
      exists: false,
      applied: false,
    })
  }
  sources.push({
    scope: 'local',
    path: paths.localPath,
    exists: false,
    applied: false,
  })

  for (const source of sources) {
    applySettingsSource(config, source, validationErrors, mcpSources)
  }

  // Managed / policySettings — loadManagedFileSettings then one apply.
  const managed = loadManagedFileSettings()
  validationErrors.push(...managed.validationErrors)
  const managedSource: SettingsSource = {
    scope: 'managed',
    path: paths.managedPath,
    exists: managed.files.length > 0,
    applied: false,
  }
  sources.push(managedSource)
  if (managed.settings) {
    if (
      managed.settings.mcpServers &&
      typeof managed.settings.mcpServers === 'object'
    ) {
      for (const name of Object.keys(managed.settings.mcpServers)) {
        mcpSources[name] = 'managed'
      }
    }
    applyLayer(config, managed.settings)
    managedSource.applied = true
    console.log(
      `[settings] Loaded managed settings from ${paths.managedPath}` +
        (managed.files.length > 1
          ? ` (+${managed.files.length - 1} drop-in)`
          : ''),
    )
  }

  return {
    config,
    mcpSources,
    sources,
    validationErrors,
    ...paths,
  }
}

export function resolveSettings(cwd: string): ResolvedSettings {
  const cacheKey = path.resolve(cwd)
  const paths = resolveSettingsPaths(cwd)
  const mtimeKey = settingsMtimeKey([
    paths.userPath,
    paths.projectPath,
    paths.localPath,
    ...listManagedSettingsFiles(),
  ])
  const cached = resolvedCache.get(cacheKey)
  if (cached && cached.mtimeKey === mtimeKey) return cached.result

  const result = resolveSettingsFromDisk(cwd)
  resolvedCache.set(cacheKey, { mtimeKey, result })
  return result
}

/**
 * Merge MCP servers from plugins plus settings files. Settings-level servers
 * win on name collision — a plugin shouldn't shadow user-configured servers.
 */
export function mergeMCPServers(
  pluginServers: Record<string, MCPServerConfig>,
  settingsServers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  return { ...pluginServers, ...settingsServers }
}

/** Settings files + plugin MCP — used at runtime and by GET /settings. */
export async function resolveEffectiveSettings(
  cwd: string,
): Promise<EffectiveSettings> {
  const resolved = resolveSettings(cwd)
  const plugins = await loadPlugins(cwd)
  const mcpProvenance: Record<string, MCPServerProvenance> = Object.fromEntries(
    Object.keys(plugins.mcpServers).map(name => [
      name,
      { configuredBy: 'plugin', writable: false },
    ]),
  )
  for (const [name, configuredBy] of Object.entries(resolved.mcpSources)) {
    const writable =
      configuredBy === 'user' ||
      configuredBy === 'project' ||
      configuredBy === 'local'
    mcpProvenance[name] = {
      configuredBy,
      writable,
      ...(writable ? { writableScope: configuredBy } : {}),
    }
  }
  return {
    ...resolved,
    effectiveMcpServers: mergeMCPServers(
      plugins.mcpServers,
      resolved.config.mcpServers,
    ),
    mcpProvenance,
  }
}

function maskApiKey(key: string): string {
  return key.replace(/.(?=.{4})/g, '*')
}

function maskProfile<T extends { apiKey?: string }>(profile: T): T {
  if (!profile.apiKey) return profile
  return { ...profile, apiKey: maskApiKey(profile.apiKey) }
}

export function getSafeSettings(
  resolved: ResolvedSettings,
): Omit<AppConfig, 'mcpServers'> {
  const copy = structuredClone(resolved.config)
  copy.models = {
    large: maskProfile(copy.models.large),
    medium: maskProfile(copy.models.medium),
    small: maskProfile(copy.models.small),
  }
  delete (copy as Partial<AppConfig>).mcpServers
  return copy
}

/**
 * EditableSettingSource excludes read-only policy/managed.
 * SSO may write `user` or `project` — when paths collapse they hit the same file.
 * `opts.ssoMode` is retained for call-site compatibility (no longer blocks user).
 */
export function parseWritableScope(
  value: unknown,
  _opts: { ssoMode: boolean },
): WritableSettingsScope {
  if (value === 'managed') {
    throw new Error(
      'managed scope is not writable (enterprise policy settings)',
    )
  }
  const scope: WritableSettingsScope =
    value === 'user' || value === 'local' || value === 'project'
      ? value
      : 'project'
  return scope
}

function pathForScope(cwd: string, scope: WritableSettingsScope): string {
  const paths = resolveSettingsPaths(cwd)
  if (scope === 'user') return paths.userPath
  if (scope === 'project') return paths.projectPath
  return paths.localPath
}

function readWritableSettings(filePath: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(filePath, 'utf-8')
    if (text.trim() === '') return {}
    const json = JSON.parse(text)
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('settings file must contain a JSON object')
    }
    return structuredClone(json) as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(
      `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

function writeSettingsFile(
  filePath: string,
  settings: Record<string, unknown>,
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n')
  resetSettingsCache()
}

function mergePatch(
  target: Record<string, unknown>,
  patch: Partial<AppConfig>,
): Record<string, unknown> {
  const next = structuredClone(target)
  // Drop legacy top-level provider if present in on-disk settings.
  delete next.provider
  if (patch.models) {
    const models = isRecord(next.models) ? { ...next.models } : {}
    for (const tier of ['large', 'medium', 'small'] as const) {
      const tierPatch = (patch.models as ModelProfiles)[tier]
      if (!tierPatch) continue
      models[tier] = {
        ...((isRecord(models[tier]) ? models[tier] : {}) as Record<
          string,
          unknown
        >),
        ...profileToRecord(tierPatch),
      }
    }
    next.models = models
  }
  if (patch.compaction) {
    next.compaction = {
      ...((next.compaction as Record<string, unknown> | undefined) ?? {}),
      ...patch.compaction,
    }
  }
  if (patch.sessionMemory) {
    next.sessionMemory = {
      ...((next.sessionMemory as Record<string, unknown> | undefined) ?? {}),
      ...patch.sessionMemory,
    }
  }
  if (typeof patch.autoMemoryEnabled === 'boolean') {
    next.autoMemoryEnabled = patch.autoMemoryEnabled
  }
  if (typeof patch.autoMemoryDirectory === 'string') {
    next.autoMemoryDirectory = patch.autoMemoryDirectory
  } else if (
    'autoMemoryDirectory' in patch &&
    patch.autoMemoryDirectory === undefined
  ) {
    delete next.autoMemoryDirectory
  }
  if (typeof patch.autoMemoryCacheSafe === 'boolean') {
    next.autoMemoryCacheSafe = patch.autoMemoryCacheSafe
  }
  if (isModelTier(patch.autoMemoryModelTier)) {
    next.autoMemoryModelTier = patch.autoMemoryModelTier
  }
  if (patch.mcpServers) {
    next.mcpServers = {
      ...((next.mcpServers as Record<string, unknown> | undefined) ?? {}),
      ...patch.mcpServers,
    }
  }
  if (patch.lspServers) {
    next.lspServers = {
      ...((next.lspServers as Record<string, unknown> | undefined) ?? {}),
      ...patch.lspServers,
    }
  }
  if (patch.disabledTools) {
    next.disabledTools = mergeStringArray(
      Array.isArray(next.disabledTools) ? (next.disabledTools as string[]) : [],
      patch.disabledTools,
    )
  }
  if (patch.scheduledTasks) {
    next.scheduledTasks = {
      ...((next.scheduledTasks as Record<string, unknown> | undefined) ?? {}),
      ...patch.scheduledTasks,
    }
  }
  if (patch.permissions) {
    const existing = isRecord(next.permissions)
      ? (next.permissions as AppConfig['permissions'])
      : undefined
    next.permissions = mergePermissionsConfig(existing, patch.permissions)
  }
  return next
}

export function patchSettings(
  cwd: string,
  scope: WritableSettingsScope,
  patch: Partial<AppConfig>,
): ResolvedSettings {
  const filePath = pathForScope(cwd, scope)
  const existing = readWritableSettings(filePath)
  writeSettingsFile(filePath, mergePatch(existing, patch))
  return resolveSettings(cwd)
}

/** Persist Always-allow to user `settings.json` (`permissions.additionalDirectories`). */
export function persistAlwaysAllowDirectory(cwd: string, absDir: string): void {
  patchSettings(cwd, 'user', {
    permissions: { additionalDirectories: [path.resolve(absDir)] },
  })
}

export function setMCPServer(
  cwd: string,
  scope: WritableSettingsScope,
  name: string,
  config: MCPServerConfig | null,
): ResolvedSettings {
  const filePath = pathForScope(cwd, scope)
  const existing = readWritableSettings(filePath)
  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, MCPServerConfig>) }
      : {}
  if (config) servers[name] = config
  else delete servers[name]
  existing.mcpServers = servers
  writeSettingsFile(filePath, existing)
  return resolveSettings(cwd)
}
