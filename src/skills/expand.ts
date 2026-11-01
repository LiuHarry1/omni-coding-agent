/**
 * Skill body expansion — shared between the model-facing `skill` dispatcher
 * tool (`tools/SkillTool/SkillTool.ts`) and the HTTP-facing direct-invocation endpoint
 * (`server/router.ts → POST /skills/:name/invoke`).
 *
 * Both call sites need to do exactly the same thing to an inline skill:
 *
 *   1. Load the SKILL.md body (lazy, via `skill.loadBody()`).
 *   2. Run `$ARGUMENTS` / `$1` / `$name` substitution.
 *   3. Replace `${SKILL_DIR}` with the skill folder path.
 *   4. Run inline `!`shell`` + `@file` directive expansion.
 *   5. Prepend the `Base directory for this skill: …` preamble.
 *
 * Keeping this in one place means HTTP callers see byte-for-byte the same
 * output the model would see — useful for testing and for callers that
 * want to feed the result back into the agent.
 */

import { substituteArguments } from '../commands/argumentSubstitution.js'
import {
  expandInlineDirectives,
  type DirectiveRuntime,
} from '../commands/promptExpansion.js'
import type { SkillDefinition } from './types.js'

export interface ExpandedSkill {
  /** `Base directory for this skill: <path>\n\n`, or empty if no baseDir. */
  preamble: string
  /** Body after all substitution / `!` / `@` / `${SKILL_DIR}` expansion. */
  expanded: string
  /** `preamble + expanded` — what callers usually want. */
  combined: string
}

export class SkillExpansionError extends Error {
  constructor(
    message: string,
    readonly code: 'BODY_READ_FAILED' | 'EMPTY_BODY',
  ) {
    super(message)
    this.name = 'SkillExpansionError'
  }
}

/**
 * Run the full inline-skill expansion pipeline. Pure with respect to the
 * eventBus — does not emit events, does not spin up subagents. For
 * `context: "fork"` skills the caller should still use this to get the
 * expanded body, then pass `combined` to their own `runAgent` invocation.
 */
export async function expandSkillBody(
  skill: SkillDefinition,
  rawArgs: string,
  cwd: string,
  directiveRuntime?: DirectiveRuntime,
): Promise<ExpandedSkill> {
  let body: string
  try {
    body = await skill.loadBody()
  } catch (e) {
    throw new SkillExpansionError(
      `failed to read SKILL.md for '${skill.name}': ${(e as Error).message}`,
      'BODY_READ_FAILED',
    )
  }
  if (!body.trim()) {
    throw new SkillExpansionError(
      `skill '${skill.name}' has an empty SKILL.md body`,
      'EMPTY_BODY',
    )
  }

  // `${SKILL_DIR}` → skill folder. Normalize backslashes on Windows so
  // shell snippets don't treat them as escape sequences.
  const effectiveBaseDir = skill.runtimeBaseDir ?? skill.baseDir
  const directiveBaseDir =
    effectiveBaseDir && process.platform === 'win32'
      ? effectiveBaseDir.replace(/\\/g, '/')
      : effectiveBaseDir
  const withSkillDir = directiveBaseDir
    ? body.replace(/\$\{SKILL_DIR\}/g, directiveBaseDir)
    : body
  const expanded = skill.untrustedBody
    ? substituteArguments(withSkillDir, rawArgs, skill.argumentNames)
    : await expandInlineDirectives(withSkillDir, cwd, directiveRuntime, {
        rawArgs,
        argumentNames: skill.argumentNames,
      })

  const preamble = effectiveBaseDir
    ? `Base directory for this skill: ${effectiveBaseDir}\n\n`
    : ''

  return { preamble, expanded, combined: preamble + expanded }
}

/**
 * Coerce HTTP-style skill arguments into the raw string format the
 * substitution layer expects.
 *
 * Accepts either:
 *   - A plain string ("audience=eng-team --strict") — passed through.
 *   - An object ({ audience: "eng-team", strict: "true" }) — flattened
 *     to `key=value key2=value2`, quoting values containing spaces.
 *
 * The model-facing path always uses the string form; the JSON-API form
 * is a quality-of-life thing for "I want to pass structured data from
 * my other project without worrying about shell quoting". Both shapes
 * end up at `substituteArguments` so `$name` / `$1` / `$ARGUMENTS` all
 * behave identically.
 */
export function normalizeSkillArguments(
  input: string | Record<string, string | number | boolean> | undefined,
): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return ''

  return Object.entries(input)
    .map(([k, v]) => {
      const s = String(v)
      // Quote values with whitespace; backslash-escape inner double quotes.
      // Simple-by-design; mirrors how a CLI user would type the same arg.
      return /\s/.test(s) ? `${k}="${s.replace(/"/g, '\\"')}"` : `${k}=${s}`
    })
    .join(' ')
}
