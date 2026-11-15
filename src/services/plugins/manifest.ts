/**
 * Plugin manifest loading + validation.
 *
 * Validates `.ai-agent-plugin/plugin.json` (or root `plugin.json`) against a
 * lean schema. A malformed manifest degrades to "no manifest" (the plugin
 * still loads from its conventional directories) rather than failing the
 * whole load.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { PluginManifest } from './types.js'

/** `${PLUGIN_ROOT}` placeholder used in agent/command/skill bodies and MCP config. */
const PLUGIN_ROOT_VARS = ['${PLUGIN_ROOT}', '${CLAUDE_PLUGIN_ROOT}'] as const

/** Manifest lives here first; falls back to a bare `plugin.json` at the root. */
export const MANIFEST_SUBDIR = '.ai-agent-plugin'
export const MANIFEST_FILE = 'plugin.json'

const PathListSchema = z.union([z.string(), z.array(z.string())])

const AuthorSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
])

/**
 * Lenient manifest schema. `.passthrough()` keeps unknown keys so future
 * fields (hooks, lsp, outputStyles…) don't get silently dropped — they're
 * simply ignored by the current loader.
 */
export const PluginManifestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'plugin name must be a safe identifier')
      .optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: AuthorSchema.optional(),
    commands: PathListSchema.optional(),
    agents: PathListSchema.optional(),
    skills: PathListSchema.optional(),
    mcpServers: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  })
  .passthrough()

export interface ManifestLoadResult {
  manifest: PluginManifest
  /** Absolute path the manifest was read from, if any. */
  manifestPath?: string
  error?: string
}

/**
 * Load + validate the manifest for a plugin directory. Returns an empty
 * manifest (no error) when no `plugin.json` exists — that's a valid plugin
 * that relies purely on directory conventions.
 */
export async function loadPluginManifest(
  pluginPath: string,
): Promise<ManifestLoadResult> {
  const candidates = [
    path.join(pluginPath, MANIFEST_SUBDIR, MANIFEST_FILE),
    path.join(pluginPath, MANIFEST_FILE),
  ]

  for (const manifestPath of candidates) {
    let raw: string
    try {
      raw = await fs.readFile(manifestPath, 'utf-8')
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      return {
        manifest: {},
        error: `failed to read ${manifestPath}: ${(e as Error).message}`,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return {
        manifest: {},
        manifestPath,
        error: `invalid JSON in ${manifestPath}: ${(e as Error).message}`,
      }
    }

    const result = PluginManifestSchema.safeParse(parsed)
    if (!result.success) {
      return {
        manifest: {},
        manifestPath,
        error: `invalid manifest ${manifestPath}: ${result.error.issues
          .map(i => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      }
    }

    return { manifest: result.data as PluginManifest, manifestPath }
  }

  return { manifest: {} }
}

/**
 * Substitute `${PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_ROOT}` when present).
 * with the plugin's absolute path so bundled scripts/assets can be referenced
 * from agent prompts, command bodies, skill bodies, and MCP configs.
 */
export function substitutePluginVars(text: string, pluginPath: string): string {
  let out = text
  for (const v of PLUGIN_ROOT_VARS) {
    out = out.split(v).join(pluginPath)
  }
  return out
}
