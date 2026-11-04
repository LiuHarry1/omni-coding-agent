/**
 * Skill definition. A skill is a markdown template the MODEL invokes
 * (via the `skill` dispatcher tool) when it needs a reusable procedure
 * — code review checklist, PR-author template, debug protocol, etc.
 *
 * Two execution modes:
 *
 *   "inline" (default): the body — after `$ARGUMENTS` / `!` / `@` expansion
 *                       — is injected as a meta user message (`newMessages`);
 *                       the tool result is `Launching skill: name`. Compact
 *                       preserves the body via session.invokedSkills.
 *
 *   "fork":            the body becomes the system prompt of a fresh
 *                      subagent (typically `general_purpose`). Useful when
 *                      the skill needs many tool calls — keeps the main
 *                      agent's context clean.
 */

import type { ExtensionSource } from '../utils/markdownConfigLoader.js'

export type SkillContextMode = 'inline' | 'fork'

export interface SkillDefinition {
  /** Name as the model invokes it via the `skill` tool. */
  name: string
  /** One-line "when to use" rendered into the skill tool's directory. */
  description: string
  /** Where the file was discovered. */
  source: 'built-in' | ExtensionSource
  /** Original file path of `SKILL.md` (file-loaded skills only). */
  filePath?: string
  /**
   * Absolute path to the skill's folder (the directory containing `SKILL.md`).
   * Surfaced to the model so it can reference bundled assets — scripts, data
   * files, sub-prompts — that live next to the skill body.
   */
  baseDir?: string
  /**
   * Path to the same package in the active execution environment. The body
   * and metadata still load from `baseDir` on the control plane.
   */
  runtimeBaseDir?: string
  /**
   * Lazily make the package available in the active execution environment.
   * Remote turns use this to keep package copies off the first-token path.
   */
  prepareRuntimeBaseDir?: () => Promise<string | undefined>
  /**
   * Body comes from a sandboxed workspace (cloud container). `!cmd` and
   * `@file` directives would run on the control plane, so they stay literal.
   */
  untrustedBody?: boolean
  /**
   * "inline" — expand body, inject as newMessages + register invokedSkills.
   * "fork"   — run as a subagent with body as system prompt.
   */
  context: SkillContextMode
  /**
   * When `context === "fork"`, which subagent_type to dispatch to.
   * Defaults to "general_purpose" if omitted.
   */
  agent?: string
  /** Named arg list for `$name` substitution (mirrors slash commands). */
  argumentNames: string[]
  /**
   * Gitignore-style path patterns (frontmatter `paths:`). When set
   * and non-empty, the skill is **conditional**: it stays hidden from the
   * model unless at least one matching file exists in the workspace. Skills
   * without `paths` are always active. Matching uses the `ignore` library
   * so patterns like `src/**` + `*.py`, `!vendor/**` work as
   * users would expect from `.gitignore`.
   */
  paths?: string[]
  /**
   * Lazy body loader. We deliberately do NOT keep the full `SKILL.md`
   * body in memory after scanning — for 100+ skills with multi-KB bodies
   * that adds up. Instead the scanner stores only frontmatter + filePath
   * here, and `loadBody()` re-reads + re-strips frontmatter on demand at
   * skill-invocation time. The result is cached per skill so repeated
   * invocations in the same chat request only pay one read.
   */
  loadBody: () => Promise<string>
}
