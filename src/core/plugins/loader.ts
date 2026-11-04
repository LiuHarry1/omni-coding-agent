/**
 * Declarative plugin loader.
 *
 * Discovers plugin directories under `~/.ai-agent/plugins/` (user scope) and
 * `<ancestor>/.ai-agent/plugins/` (project scope, walked up to home), then
 * collects their agents / commands / skills / MCP servers into a single
 * `PluginContributions` bundle.
 *
 * Component-loader split (`loadPluginAgents`, `loadPluginCommands`,
 * `mcpPluginIntegration`), tailored to this repo's flat `.ai-agent/` model: plugin contributions carry
 * `source: "plugin"` — the LOWEST override priority — so anything in the
 * user's or project's own `.ai-agent/` wins on a name collision.
 *
 * Called once per chat turn (cheap: frontmatter-only reads, parallel IO),
 * so dropping a plugin folder takes effect on the next message without a
 * server restart — same hot-reload contract as `registerSubagents`.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import type { MCPServerConfig } from '../types.js'
import {
  getProjectAppDirsUpToHome,
  getUserAppDir,
} from '../../utils/app-dir.js'
import {
  loadMarkdownFilesFromDir,
  loadMarkdownFile,
  type MarkdownFile,
} from '../../utils/markdownConfigLoader.js'
import {
  loadSkillsFromDir,
  type SkillLoadResult,
} from '../../skills/loadSkillsDir.js'
import type { SkillDefinition } from '../../skills/types.js'
import { loadPluginManifest, substitutePluginVars } from './manifest.js'
import type {
  LoadedPlugin,
  PluginContributions,
  PluginManifest,
  PluginScope,
} from './types.js'

const PLUGINS_DIRNAME = 'plugins'
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

/** Plugin roots, deepest project first, then user scope (lowest priority). */
function getPluginRoots(
  cwd: string,
): Array<{ dir: string; scope: PluginScope }> {
  const projectRoots = getProjectAppDirsUpToHome(cwd).map(appDir => ({
    dir: path.join(appDir, PLUGINS_DIRNAME),
    scope: 'project' as const,
  }))
  return [
    ...projectRoots,
    {
      dir: path.join(getUserAppDir(), PLUGINS_DIRNAME),
      scope: 'user' as const,
    },
  ]
}

function toPathList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** Build a LoadedPlugin from one plugin directory (auto-detect + manifest). */
async function loadPluginFromPath(
  pluginPath: string,
  scope: PluginScope,
  errors: PluginContributions['errors'],
): Promise<LoadedPlugin | null> {
  const dirName = path.basename(pluginPath)
  const { manifest, error: manifestError } =
    await loadPluginManifest(pluginPath)
  if (manifestError) {
    errors.push({
      type: 'manifest-invalid',
      source: pluginPath,
      detail: manifestError,
    })
  }

  const name = manifest.name ?? dirName
  if (!NAME_RE.test(name)) {
    errors.push({ type: 'invalid-name', source: pluginPath, name })
    return null
  }

  // Agent paths: manifest override (if any) else conventional `agents/`.
  const agentPaths = await resolveComponentPaths(
    pluginPath,
    manifest.agents,
    'agents',
  )
  const commandPaths = await resolveComponentPaths(
    pluginPath,
    manifest.commands,
    'commands',
  )
  const skillPaths = await resolveComponentPaths(
    pluginPath,
    manifest.skills,
    'skills',
  )

  const mcpSources = await resolveMcpSources(pluginPath, manifest)

  return {
    name,
    path: pluginPath,
    manifest,
    scope,
    agentPaths,
    commandPaths,
    skillPaths,
    mcpSources,
  }
}

/** Manifest paths win if present; otherwise auto-detect the conventional dir. */
async function resolveComponentPaths(
  pluginPath: string,
  manifestValue: string | string[] | undefined,
  conventionalDir: string,
): Promise<string[]> {
  const overrides = toPathList(manifestValue)
  if (overrides.length > 0) {
    return overrides.map(rel => path.resolve(pluginPath, rel))
  }
  const dir = path.join(pluginPath, conventionalDir)
  return (await isDir(dir)) ? [dir] : []
}

async function resolveMcpSources(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<Array<string | Record<string, MCPServerConfig>>> {
  const sources: Array<string | Record<string, MCPServerConfig>> = []

  const defaultMcp = path.join(pluginPath, '.mcp.json')
  if (await exists(defaultMcp)) sources.push(defaultMcp)

  if (typeof manifest.mcpServers === 'string') {
    sources.push(path.resolve(pluginPath, manifest.mcpServers))
  } else if (manifest.mcpServers && typeof manifest.mcpServers === 'object') {
    sources.push(manifest.mcpServers)
  }

  return sources
}

// ── Component collection ─────────────────────────────────────────────────

async function collectAgentFiles(
  plugin: LoadedPlugin,
): Promise<MarkdownFile[]> {
  const out: MarkdownFile[] = []
  for (const p of plugin.agentPaths) {
    const files = await loadMarkdownFromPath(p, plugin.path)
    out.push(...files)
  }
  return out
}

async function collectCommandFiles(
  plugin: LoadedPlugin,
): Promise<MarkdownFile[]> {
  const out: MarkdownFile[] = []
  for (const p of plugin.commandPaths) {
    const files = await loadMarkdownFromPath(p, plugin.path)
    out.push(...files)
  }
  return out
}

/** Load .md files from a dir OR a single .md file, substituting `${PLUGIN_ROOT}`. */
async function loadMarkdownFromPath(
  sourcePath: string,
  pluginPath: string,
): Promise<MarkdownFile[]> {
  let files: MarkdownFile[]
  if (await isDir(sourcePath)) {
    files = await loadMarkdownFilesFromDir(sourcePath, 'plugin')
  } else if (sourcePath.endsWith('.md')) {
    const file = await loadMarkdownFile(sourcePath, 'plugin')
    files = file ? [file] : []
  } else {
    return []
  }
  // Substitute ${PLUGIN_ROOT} so plugin bodies can reference bundled assets.
  return files.map(f => ({
    ...f,
    body: substitutePluginVars(f.body, pluginPath),
  }))
}

async function collectSkills(
  plugin: LoadedPlugin,
  errors: PluginContributions['errors'],
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []
  for (const skillsDir of plugin.skillPaths) {
    let results: SkillLoadResult[]
    try {
      results = await loadSkillsFromDir(skillsDir, 'plugin')
    } catch (e) {
      errors.push({
        type: 'skill-load-failed',
        source: skillsDir,
        detail: (e as Error).message,
      })
      continue
    }
    for (const r of results) {
      if (r.error)
        errors.push({
          type: 'skill-invalid',
          source: r.filePath,
          detail: r.error,
        })
      if (r.skill) skills.push(wrapSkillBody(r.skill, plugin.path))
    }
  }
  return skills
}

/** Wrap a skill's lazy body loader to substitute `${PLUGIN_ROOT}`. */
function wrapSkillBody(
  skill: SkillDefinition,
  pluginPath: string,
): SkillDefinition {
  const originalLoad = skill.loadBody
  return {
    ...skill,
    loadBody: async () =>
      substitutePluginVars(await originalLoad(), pluginPath),
  }
}

async function collectMcpServers(
  plugin: LoadedPlugin,
  errors: PluginContributions['errors'],
): Promise<Record<string, MCPServerConfig>> {
  const servers: Record<string, MCPServerConfig> = {}
  for (const source of plugin.mcpSources) {
    const record =
      typeof source === 'string' ? await readMcpJson(source, errors) : source
    if (!record) continue
    for (const [name, config] of Object.entries(record)) {
      servers[name] = resolveMcpVars(config, plugin.path)
    }
  }
  return servers
}

async function readMcpJson(
  filePath: string,
  errors: PluginContributions['errors'],
): Promise<Record<string, MCPServerConfig> | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    errors.push({
      type: 'mcp-read-failed',
      source: filePath,
      detail: (e as Error).message,
    })
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    // Support both `{ mcpServers: {...} }` and a flat `{...}` record.
    return (parsed.mcpServers ?? parsed) as Record<string, MCPServerConfig>
  } catch (e) {
    errors.push({
      type: 'mcp-invalid-json',
      source: filePath,
      detail: (e as Error).message,
    })
    return null
  }
}

/** Substitute `${PLUGIN_ROOT}` in MCP command/args/env/url/headers. */
function resolveMcpVars(
  config: MCPServerConfig,
  pluginPath: string,
): MCPServerConfig {
  const sub = (s: string) => substitutePluginVars(s, pluginPath)
  if ('command' in config) {
    return {
      ...config,
      command: sub(config.command),
      args: config.args?.map(sub),
      env: config.env
        ? Object.fromEntries(
            Object.entries(config.env).map(([k, v]) => [k, sub(v)]),
          )
        : undefined,
    }
  }
  return {
    ...config,
    url: sub(config.url),
    headers: config.headers
      ? Object.fromEntries(
          Object.entries(config.headers).map(([k, v]) => [k, sub(v)]),
        )
      : undefined,
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Discover plugins reachable from `cwd` and collect everything they
 * contribute. Project-scope plugins override user-scope ones of the same name.
 */
async function loadPluginsFresh(cwd: string): Promise<PluginContributions> {
  const errors: PluginContributions['errors'] = []
  const roots = getPluginRoots(cwd)

  // Discover plugin dirs. `byName` dedups so a project plugin shadows a
  // user plugin with the same directory name (roots are deepest-first).
  const byName = new Map<string, LoadedPlugin>()
  for (const { dir, scope } of roots) {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const loaded = await Promise.all(
      entries
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => loadPluginFromPath(path.join(dir, e.name), scope, errors)),
    )
    for (const plugin of loaded) {
      if (plugin && !byName.has(plugin.name)) byName.set(plugin.name, plugin)
    }
  }

  const plugins = [...byName.values()]

  const [agentLists, commandLists, skillLists, mcpRecords] = await Promise.all([
    Promise.all(plugins.map(p => collectAgentFiles(p))),
    Promise.all(plugins.map(p => collectCommandFiles(p))),
    Promise.all(plugins.map(p => collectSkills(p, errors))),
    Promise.all(plugins.map(p => collectMcpServers(p, errors))),
  ])

  // Flat MCP namespace: warn on cross-plugin name collisions (later plugin
  // wins). Some implementations scope as `plugin:{name}:{server}`; we keep
  // flat names but surface the shadowing instead of hiding it.
  const mcpServers: Record<string, MCPServerConfig> = {}
  const mcpOwner: Record<string, string> = {}
  mcpRecords.forEach((record, i) => {
    const pluginName = plugins[i]!.name
    for (const [name, config] of Object.entries(record)) {
      if (mcpOwner[name]) {
        errors.push({
          type: 'mcp-collision',
          plugin: pluginName,
          server: name,
          shadowed: mcpOwner[name]!,
        })
        console.warn(
          `[plugins] MCP server '${name}' from plugin '${pluginName}' shadows '${mcpOwner[name]}'`,
        )
      }
      mcpServers[name] = config
      mcpOwner[name] = pluginName
    }
  })

  return {
    plugins,
    agentFiles: agentLists.flat(),
    commandFiles: commandLists.flat(),
    skills: skillLists.flat(),
    mcpServers,
    errors,
  }
}

type PluginCacheEntry = {
  value: PluginContributions
  fingerprint: string
}

const pluginCache = new Map<string, PluginCacheEntry>()
/** roots → plugin → component dir → file/skill dir → SKILL.md */
const PLUGIN_TREE_DEPTH = 4

/** Stat-only signature of a tree: catches added, removed, and edited entries. */
async function fingerprintPath(p: string, depth: number): Promise<string> {
  let stat: import('fs').Stats
  try {
    stat = await fs.stat(p)
  } catch {
    return `${p}|-`
  }
  const self = `${p}|${stat.mtimeMs}|${stat.size}`
  if (!stat.isDirectory() || depth <= 0) return self
  let names: string[]
  try {
    names = (await fs.readdir(p)).sort()
  } catch {
    return self
  }
  const children = await Promise.all(
    names.map(name => fingerprintPath(path.join(p, name), depth - 1)),
  )
  return [self, ...children].join('\n')
}

async function pluginTreeFingerprint(cwd: string): Promise<string> {
  const parts = await Promise.all(
    getPluginRoots(cwd).map(root =>
      fingerprintPath(root.dir, PLUGIN_TREE_DEPTH),
    ),
  )
  return parts.join('\n')
}

/** Manifest paths outside the plugin folder are invisible to the fingerprint. */
function hasExternalComponentPaths(value: PluginContributions): boolean {
  return value.plugins.some(plugin =>
    [
      ...plugin.agentPaths,
      ...plugin.commandPaths,
      ...plugin.skillPaths,
      ...plugin.mcpSources.filter(
        (source): source is string => typeof source === 'string',
      ),
    ].some(p => {
      const rel = path.relative(plugin.path, p)
      return rel.startsWith('..') || path.isAbsolute(rel)
    }),
  )
}

/**
 * Reuse the last plugin snapshot while the plugin trees are unchanged. The
 * stat-only fingerprint is far cheaper than re-reading every frontmatter and
 * `.mcp.json`, and keeps the next-message hot-reload contract.
 */
export async function loadPlugins(cwd: string): Promise<PluginContributions> {
  const key = path.resolve(cwd)
  const fingerprint = await pluginTreeFingerprint(cwd)
  const cached = pluginCache.get(key)
  if (cached?.fingerprint === fingerprint) return cached.value

  const value = await loadPluginsFresh(cwd)
  if (hasExternalComponentPaths(value)) pluginCache.delete(key)
  else pluginCache.set(key, { value, fingerprint })
  return value
}

export function invalidatePluginCache(cwd?: string): void {
  if (cwd) pluginCache.delete(path.resolve(cwd))
  else pluginCache.clear()
}
