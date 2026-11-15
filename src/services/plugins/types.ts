/**
 * Declarative plugin system — types.
 *
 * plugin architecture (`src/types/plugin.ts` +
 * `src/utils/plugins/schemas.ts`): a plugin is a *directory* of declarative
 * content (markdown agents/commands, SKILL.md folders, MCP server config),
 * NOT executed JavaScript. The loader scans the directory, validates an
 * optional manifest, and produces typed contributions that are merged into
 * the same registries the built-in `.ai-agent/` config uses.
 *
 * Directory layout (`.ai-agent-plugin/plugin.json`, falling back to a root
 * `plugin.json`):
 *
 *   <plugins-root>/my-plugin/
 *   ├── .ai-agent-plugin/
 *   │   └── plugin.json        # optional manifest (metadata + path overrides)
 *   ├── agents/*.md            # subagent definitions
 *   ├── commands/*.md          # slash commands
 *   ├── skills/<name>/SKILL.md # skills
 *   └── .mcp.json              # MCP server configs (optional)
 *
 * Plugins live under:
 *   ~/.ai-agent/plugins/              (user scope)
 *   <ancestor>/.ai-agent/plugins/     (project scope, walked up to home)
 */

import type { MCPServerConfig } from '../../core/types.js'
import type { MarkdownFile } from '../../utils/markdownConfigLoader.js'
import type { SkillDefinition } from '../../skills/types.js'

export interface PluginAuthor {
  name: string
  email?: string
  url?: string
}

/**
 * Parsed `plugin.json`. All fields optional — a plugin with no manifest is
 * valid (name is derived from the directory). Unknown keys are preserved.
 */
export interface PluginManifest {
  name?: string
  version?: string
  description?: string
  author?: string | PluginAuthor
  /** Override/add command source paths (relative to plugin root). */
  commands?: string | string[]
  /** Override/add agent source paths (relative to plugin root). */
  agents?: string | string[]
  /** Override/add skill source paths (relative to plugin root). */
  skills?: string | string[]
  /**
   * MCP servers: a path to a JSON file (relative to plugin root) or an inline
   * record of `{ serverName: config }`.
   */
  mcpServers?: string | Record<string, MCPServerConfig>
  [key: string]: unknown
}

/** Scope a plugin was discovered in (used for override precedence). */
export type PluginScope = 'user' | 'project'

/**
 * A discovered plugin on disk. Paths are absolute and only present when the
 * corresponding directory/file actually exists (auto-detected) or is declared
 * in the manifest.
 */
export interface LoadedPlugin {
  /** Resolved name (manifest.name ?? directory basename). */
  name: string
  /** Absolute path to the plugin root directory. */
  path: string
  /** Parsed manifest (empty object if none on disk). */
  manifest: PluginManifest
  scope: PluginScope
  /** Absolute agent source paths (dirs and/or .md files). */
  agentPaths: string[]
  /** Absolute command source paths (dirs and/or .md files). */
  commandPaths: string[]
  /** Absolute skill source directories (each containing `<name>/SKILL.md`). */
  skillPaths: string[]
  /** Absolute MCP config file paths and/or inline server records. */
  mcpSources: Array<string | Record<string, MCPServerConfig>>
}

/**
 * Structured, non-fatal plugin load error. A lean version of 's
 * discriminated `PluginError` union (`src/types/plugin.ts`) — typed so the
 * `/plugins` command and logs can format errors consistently and callers can
 * branch on `type` instead of string-matching messages.
 */
export type PluginError =
  | { type: 'manifest-invalid'; source: string; detail: string }
  | { type: 'invalid-name'; source: string; name: string }
  | { type: 'mcp-read-failed'; source: string; detail: string }
  | { type: 'mcp-invalid-json'; source: string; detail: string }
  | { type: 'mcp-collision'; plugin: string; server: string; shadowed: string }
  | { type: 'skill-load-failed'; source: string; detail: string }
  | { type: 'skill-invalid'; source: string; detail: string }

/** Human-readable one-liner for a structured plugin error. */
export function pluginErrorMessage(e: PluginError): string {
  switch (e.type) {
    case 'manifest-invalid':
      return `invalid manifest: ${e.detail}`
    case 'invalid-name':
      return `invalid plugin name '${e.name}'`
    case 'mcp-read-failed':
      return `failed to read MCP config: ${e.detail}`
    case 'mcp-invalid-json':
      return `invalid MCP config JSON: ${e.detail}`
    case 'mcp-collision':
      return `MCP server '${e.server}' from plugin '${e.plugin}' shadows the one from '${e.shadowed}'`
    case 'skill-load-failed':
      return `failed to load skills: ${e.detail}`
    case 'skill-invalid':
      return `invalid skill: ${e.detail}`
  }
}

/** The on-disk location (plugin path, file, or plugin name) an error refers to. */
export function pluginErrorSource(e: PluginError): string {
  return 'source' in e ? e.source : e.plugin
}

/** Everything plugins contribute, ready to merge into the existing pipeline. */
export interface PluginContributions {
  plugins: LoadedPlugin[]
  /** Agent markdown files (source: "plugin"), `${PLUGIN_ROOT}` already substituted. */
  agentFiles: MarkdownFile[]
  /** Command markdown files (source: "plugin"), `${PLUGIN_ROOT}` already substituted. */
  commandFiles: MarkdownFile[]
  /** Skills (source: "plugin"), bodies substitute `${PLUGIN_ROOT}` lazily. */
  skills: SkillDefinition[]
  /** MCP servers keyed by (flat) server name. Config-level servers win on collision. */
  mcpServers: Record<string, MCPServerConfig>
  /** Non-fatal load errors, surfaced by `/plugins` and logs. */
  errors: PluginError[]
}
