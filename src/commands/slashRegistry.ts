/**
 * Single source of truth for everything reachable via `/<name>`:
 * built-ins, file-loaded slash commands, and skill folders.
 *
 * On duplicate `name`, **skill > command > built-in** (skill files always win).
 *
 * Consumers:
 *   - `commands/dispatcher.ts`  — parse `/x` and route
 *   - `server/router.ts`         — GET /slash-commands for UI autocomplete
 *   - `formatHelp()`             — text reply for `/help`
 */

import { sep } from 'path'
import {
  loadMarkdownConfigs,
  getAppDirName,
} from '../utils/markdownConfigLoader.js'
import {
  loadSkillsFromDisk,
  mergeSkillsByName,
} from '../skills/loadSkillsDir.js'
import { loadPlugins } from '../core/plugins/loader.js'
import { pluginErrorMessage, pluginErrorSource } from '../core/plugins/types.js'
import { mergeCommands } from './loadCommandsFromFiles.js'
import type { SlashCommand } from './types.js'
import type { SkillDefinition } from '../skills/types.js'

/**
 * Unified slash menu entry. Discriminated by `kind`:
 *   - `built-in`: handled in-dispatcher (e.g. `/help`)
 *   - `command`:  body comes from a `.md` template
 *   - `skill`:    folder-based; may run inline OR fork a subagent
 *
 * `command` and `skill` carry their underlying def by reference so callers
 * don't have to look up again. Built-ins have no def.
 */
export type SlashEntry =
  | {
      kind: 'built-in'
      name: string
      description: string
      argumentHint?: string
    }
  | {
      kind: 'command'
      name: string
      description: string
      argumentHint?: string
      def: SlashCommand
    }
  | {
      kind: 'skill'
      name: string
      description: string
      argumentHint?: string
      /** "inline" → expand into prompt; "fork" → run isolated subagent. */
      context: SkillDefinition['context']
      def: SkillDefinition
    }

/** Built-ins exposed in every workspace. Kept here so help/autocomplete agree. */
export const BUILTIN_SLASH_ENTRIES: SlashEntry[] = [
  {
    kind: 'built-in',
    name: 'help',
    description: 'List all available slash commands and skills.',
  },
  {
    kind: 'built-in',
    name: 'commands',
    description: 'Alias for /help.',
  },
  {
    kind: 'built-in',
    name: 'plan',
    description:
      'Enter or view plan mode. Use /plan open for the plan file path.',
    argumentHint: '[open|<description>]',
  },
  {
    kind: 'built-in',
    name: 'plugins',
    description: 'List installed plugins and any load errors.',
  },
  {
    kind: 'built-in',
    name: 'compact',
    description:
      'Summarize the conversation now to free context. Optionally focus the summary.',
    argumentHint: '[focus instructions]',
  },
  {
    kind: 'built-in',
    name: 'summary',
    description:
      'Force an immediate update of the session-memory notes file (waits for completion).',
  },
]

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_ENTRIES.map(e => e.name))

function skillArgumentHint(skill: SkillDefinition): string | undefined {
  if (skill.argumentNames.length === 0) return undefined
  return '[' + skill.argumentNames.join(' ') + ']'
}

/**
 * Discover everything `/`-invokable for `cwd`.
 *
 * Returns the merged list (sorted by name) plus the raw collections — the
 * dispatcher needs both: the merged map for "what name resolves to what",
 * and the originals for `/help` source attribution if we ever add it.
 */
export async function loadSlashRegistry(
  cwd: string,
  opts: {
    mapProjectSkill?: (skill: SkillDefinition) => SkillDefinition
  } = {},
): Promise<{
  entries: SlashEntry[]
  commands: SlashCommand[]
  skills: SkillDefinition[]
}> {
  const [commandFiles, loaded, contributions] = await Promise.all([
    loadMarkdownConfigs('commands', cwd),
    loadSkillsFromDisk(cwd),
    loadPlugins(cwd),
  ])
  const mapProject = opts.mapProjectSkill
  const diskSkills = mapProject
    ? loaded.skills.map(s => (s.source === 'project' ? mapProject(s) : s))
    : loaded.skills
  // Plugin lowest; managed (policy) highest via sourceRank / mergeSkillsByName.
  const commands = mergeCommands([
    ...contributions.commandFiles,
    ...commandFiles,
  ]).commands
  const skills = mergeSkillsByName(contributions.skills, diskSkills)

  const byName = new Map<string, SlashEntry>()

  for (const e of BUILTIN_SLASH_ENTRIES) byName.set(e.name, e)

  for (const c of commands) {
    if (BUILTIN_NAMES.has(c.name)) {
      console.warn(`[slash] command '/${c.name}' shadowed by built-in; ignored`)
      continue
    }
    byName.set(c.name, {
      kind: 'command',
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      def: c,
    })
  }

  // Skill overrides command on duplicate name; built-ins are
  // protected.
  for (const s of skills) {
    if (BUILTIN_NAMES.has(s.name)) {
      console.warn(`[slash] skill '/${s.name}' shadowed by built-in; ignored`)
      continue
    }
    byName.set(s.name, {
      kind: 'skill',
      name: s.name,
      description: s.description,
      argumentHint: skillArgumentHint(s),
      context: s.context,
      def: s,
    })
  }

  const entries = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  return { entries, commands, skills }
}

/** Stripped view for HTTP/UI — never leaks the underlying def. */
export interface PublicSlashEntry {
  name: string
  description: string
  kind: SlashEntry['kind']
  argumentHint?: string
  context?: SkillDefinition['context']
  source:
    'built-in' | import('../utils/markdownConfigLoader.js').ExtensionSource
  filePath?: string
}

export function toPublicEntry(e: SlashEntry): PublicSlashEntry {
  if (e.kind === 'skill') {
    return {
      name: e.name,
      description: e.description,
      kind: e.kind,
      argumentHint: e.argumentHint,
      context: e.context,
      source: e.def.source,
      filePath: e.def.filePath,
    }
  }
  if (e.kind === 'command') {
    return {
      name: e.name,
      description: e.description,
      kind: e.kind,
      argumentHint: e.argumentHint,
      source: e.def.source,
      filePath: e.def.filePath,
    }
  }
  return {
    name: e.name,
    description: e.description,
    kind: e.kind,
    source: 'built-in',
  }
}

export function lookupSlash(
  entries: readonly SlashEntry[],
  name: string,
): SlashEntry | undefined {
  return entries.find(e => e.name === name)
}

/** Markdown reply for `/help`. */
export function formatHelp(entries: readonly SlashEntry[]): string {
  const userDefined = entries.filter(e => e.kind !== 'built-in').length
  const header =
    userDefined === 0
      ? '**Available slash commands & skills** (built-in only):'
      : `**Available slash commands & skills** (${userDefined} user-defined):`

  const lines = entries.map(e => {
    const hint =
      e.kind !== 'built-in' && e.argumentHint ? ` ${e.argumentHint}` : ''
    const badge =
      e.kind === 'skill'
        ? e.context === 'fork'
          ? ' · skill/fork'
          : ' · skill'
        : e.kind === 'command'
          ? ' · command'
          : ''
    return `  /${e.name}${hint} — ${e.description}${badge}`
  })

  const footer =
    userDefined === 0
      ? `\nDrop commands into \`<cwd>/${getAppDirName()}/commands/\` or skills into \`<cwd>/${getAppDirName()}/skills/<name>/SKILL.md\`.`
      : ''

  return [header, '', ...lines, footer].join('\n').trimEnd()
}

// ── /plugins ──────────────────────────────────────────────────────────────

/** Per-plugin summary (counts derived by matching contribution paths). */
export interface PluginSummary {
  name: string
  scope: 'user' | 'project'
  version?: string
  description?: string
  path: string
  agents: number
  commands: number
  skills: number
  mcp: number
}

export interface PluginsOverview {
  plugins: PluginSummary[]
  errors: Array<{ type: string; source: string; message: string }>
}

/**
 * Discover plugins for `cwd` and roll them up into a UI/CLI-friendly shape.
 * Per-plugin component counts are derived by matching each contribution's
 * file path against the plugin root — no second scan.
 */
export async function loadPluginsOverview(
  cwd: string,
): Promise<PluginsOverview> {
  const c = await loadPlugins(cwd)
  const underRoot = (p: string | undefined, root: string) =>
    !!p && (p === root || p.startsWith(root + sep) || p.startsWith(root + '/'))

  const plugins: PluginSummary[] = c.plugins.map(p => ({
    name: p.name,
    scope: p.scope,
    version:
      typeof p.manifest.version === 'string' ? p.manifest.version : undefined,
    description:
      typeof p.manifest.description === 'string'
        ? p.manifest.description
        : undefined,
    path: p.path,
    agents: c.agentFiles.filter(f => underRoot(f.filePath, p.path)).length,
    commands: c.commandFiles.filter(f => underRoot(f.filePath, p.path)).length,
    skills: c.skills.filter(s => underRoot(s.baseDir ?? s.filePath, p.path))
      .length,
    // Number of MCP config sources the plugin declares (.mcp.json + manifest).
    mcp: p.mcpSources.length,
  }))

  const errors = c.errors.map(e => ({
    type: e.type,
    source: pluginErrorSource(e),
    message: pluginErrorMessage(e),
  }))

  return { plugins, errors }
}

/** Markdown reply for `/plugins`. */
export function formatPlugins(overview: PluginsOverview): string {
  const { plugins, errors } = overview

  if (plugins.length === 0 && errors.length === 0) {
    return [
      '**No plugins installed.**',
      '',
      `Drop a plugin folder into \`<cwd>/${getAppDirName()}/plugins/<name>/\` ` +
        `(with \`agents/\`, \`commands/\`, \`skills/\`, and/or \`.mcp.json\`).`,
    ].join('\n')
  }

  const lines = plugins.map(p => {
    const meta = [p.version ? `v${p.version}` : null, p.description]
      .filter(Boolean)
      .join(' · ')
    const counts = `agents: ${p.agents}, commands: ${p.commands}, skills: ${p.skills}, mcp: ${p.mcp}`
    return `- **${p.name}** @${p.scope}${meta ? ` — ${meta}` : ''}\n    ${counts}`
  })

  const out = [`**Plugins** (${plugins.length} loaded):`, '', ...lines]

  if (errors.length > 0) {
    out.push('', `**Errors** (${errors.length}):`)
    for (const e of errors)
      out.push(`  - [${e.type}] ${e.source}: ${e.message}`)
  }

  return out.join('\n').trimEnd()
}

/** Convenience: load + format in one call for the `/plugins` dispatcher path. */
export async function formatPluginsReply(cwd: string): Promise<string> {
  return formatPlugins(await loadPluginsOverview(cwd))
}
