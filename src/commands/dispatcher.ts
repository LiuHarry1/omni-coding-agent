/**
 * Slash-command dispatcher.
 *
 * Single job: take the raw user message, decide what `/` means in this
 * context, and return a uniform `DispatchResult` for the router to act on.
 * No transport, no SSE, no subagent execution — those live one layer up.
 *
 * Result shape (one verb, mode-discriminated payload):
 *
 *   - passthrough → not a slash command; forward unchanged
 *   - reply       → immediate text to show the user (no LLM)
 *   - run         → expanded body to execute; `mode` says how
 *   - unknown     → leading `/` but name didn't resolve
 */

import { expandSkillBody, SkillExpansionError } from '../skills/expand.js'
import {
  expandInlineDirectives,
  type DirectiveRuntime,
} from './promptExpansion.js'
import {
  formatHelp,
  formatPluginsReply,
  loadSlashRegistry,
  lookupSlash,
  toPublicEntry,
  type SlashEntry,
} from './slashRegistry.js'

const SLASH_LINE_RE = /^\/([a-z0-9][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/i

interface ParsedSlash {
  name: string
  args: string
}

function parseSlashLine(message: string): ParsedSlash | null {
  if (!message.startsWith('/')) return null
  const match = message.trimEnd().match(SLASH_LINE_RE)
  if (!match) return null
  return { name: match[1]!, args: (match[2] ?? '').trim() }
}

export type DispatchResult =
  | { kind: 'passthrough' }
  | { kind: 'reply'; text: string }
  | { kind: 'compact'; instructions: string }
  | { kind: 'summary' }
  | {
      kind: 'run'
      /** `inline` feeds expanded text to the main agent; `fork` runs a subagent. */
      mode: 'inline' | 'fork'
      /** Expanded body — already preamble + args + !`shell` + @file replaced. */
      text: string
      entry: SlashEntry
    }
  | { kind: 'unknown'; name: string; available: string[] }

export interface DispatcherDeps {
  /** Execution-environment cwd used by `!` and `@` directives. */
  cwd: string
  /** Host cwd used only to discover extensions and render `/plugins`. */
  extensionCwd?: string
  directiveRuntime?: DirectiveRuntime
}

/**
 * Resolve a slash-command line. `entries` is optional — pass it when the
 * caller already loaded the registry (avoids re-scanning the filesystem).
 */
export async function dispatchSlashCommand(
  message: string,
  deps: DispatcherDeps,
  preloaded?: { entries: SlashEntry[] },
): Promise<DispatchResult> {
  const parsed = parseSlashLine(message)
  if (!parsed) return { kind: 'passthrough' }

  const entries =
    preloaded?.entries ??
    (await loadSlashRegistry(deps.extensionCwd ?? deps.cwd)).entries

  const entry = lookupSlash(entries, parsed.name)
  if (!entry) {
    return {
      kind: 'unknown',
      name: parsed.name,
      available: entries.map(e => e.name),
    }
  }

  if (entry.kind === 'built-in') {
    if (entry.name === 'help' || entry.name === 'commands') {
      return { kind: 'reply', text: formatHelp(entries) }
    }
    if (entry.name === 'plugins') {
      return {
        kind: 'reply',
        text: await formatPluginsReply(deps.extensionCwd ?? deps.cwd),
      }
    }
    if (entry.name === 'compact') {
      // Manual compaction. Args (if any) steer the summary focus; the actual
      // summarization runs in the chat route, which holds the session history.
      return { kind: 'compact', instructions: parsed.args }
    }
    if (entry.name === 'summary') {
      return { kind: 'summary' }
    }
    return { kind: 'reply', text: `Built-in /${entry.name} not implemented` }
  }

  if (entry.kind === 'command') {
    const expanded = await expandInlineDirectives(
      entry.def.body,
      deps.cwd,
      deps.directiveRuntime,
      {
        rawArgs: parsed.args,
        argumentNames: entry.def.argumentNames,
      },
    )
    return { kind: 'run', mode: 'inline', text: expanded, entry }
  }

  // entry.kind === "skill"
  try {
    const { combined } = await expandSkillBody(
      entry.def,
      parsed.args,
      deps.cwd,
      deps.directiveRuntime,
    )

    // If the skill body doesn't consume $ARGUMENTS / $1 / $name (common for
    // reference-style skills like /pdf), the user's actual request would be
    // silently lost. Always append the raw args so the agent sees both the
    // skill context AND what the user wants done.
    const userArgs = parsed.args.trim()
    const text = userArgs
      ? `${combined}\n\n---\n\nUser request: ${userArgs}`
      : combined

    return {
      kind: 'run',
      mode: entry.context === 'fork' ? 'fork' : 'inline',
      text,
      entry,
    }
  } catch (e) {
    const msg =
      e instanceof SkillExpansionError ? e.message : (e as Error).message
    return {
      kind: 'reply',
      text: `Error expanding skill '/${parsed.name}': ${msg}`,
    }
  }
}

/**
 * HTTP/UI-friendly listing for `GET /slash-commands`. Returns the same
 * entries `/help` shows, in `PublicSlashEntry` shape (no def references).
 */
export async function listSlashCommands(cwd: string) {
  const { entries } = await loadSlashRegistry(cwd)
  return entries.map(toPublicEntry)
}
