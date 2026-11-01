import type { AgentDefinition, IToolRegistry } from '../core/types.js'
import {
  loadSkillsFromDisk,
  filterSkillsByPaths,
  mergeSkillsByName,
} from './loadSkillsDir.js'
import {
  createSkillTool,
  SKILL_TOOL_NAME,
} from '../tools/SkillTool/SkillTool.js'
import type { SkillDefinition } from './types.js'

export { SKILL_TOOL_NAME, filterSkillsByPaths }
export type { SkillDefinition }
export {
  addInvokedSkill,
  getInvokedSkillsForAgent,
  restoreInvokedSkillsFromMessages,
} from './invoked-skills.js'
export type { InvokedSkillInfo } from './invoked-skills.js'

// ── Skill listing for <system-reminder> injection ────────────────────────

// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000
export const MAX_LISTING_DESC_CHARS = 250
const MIN_DESC_LENGTH = 20

function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}

function truncateDesc(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '\u2026'
}

function listingDescription(desc: string): string {
  return truncateDesc(desc, MAX_LISTING_DESC_CHARS)
}

/**
 * Format a skill listing suitable for `<system-reminder>` injection.
 * Each entry is formatted within budget as `- name: desc`.
 */
export function formatSkillListing(
  skills: readonly SkillDefinition[],
  contextWindowTokens?: number,
): string {
  if (skills.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)
  const lines = skills.map(
    s => `- ${s.name}: ${listingDescription(s.description)}`,
  )
  const full = lines.join('\n')

  if (full.length <= budget) return full

  const nameOverhead =
    skills.reduce((sum, s) => sum + s.name.length + 4, 0) + (skills.length - 1)
  const available = budget - nameOverhead
  const maxDesc = Math.floor(available / skills.length)

  if (maxDesc < MIN_DESC_LENGTH) {
    return skills.map(s => `- ${s.name}`).join('\n')
  }

  return skills
    .map(
      s =>
        `- ${s.name}: ${truncateDesc(listingDescription(s.description), maxDesc)}`,
    )
    .join('\n')
}

export interface RegisterSkillsOptions {
  /**
   * Skills contributed by plugins (source "plugin"). Merged at the LOWEST
   * priority, so a disk skill (`.ai-agent/skills/`) with the same name wins.
   */
  pluginSkills?: readonly SkillDefinition[]
  /** Already merged skills from the turn's slash registry. */
  preloadedSkills?: readonly SkillDefinition[]
  /**
   * File paths to evaluate `paths:` frontmatter against. Skills whose
   * `paths` patterns match at least one of these become active for this
   * chat turn; non-matching conditional skills stay hidden. Pass the
   * files mentioned in the user's current message, recently edited
   * files, or `git ls-files` output — whatever signal best represents
   * "what's relevant right now".
   *
   * Omit (or pass `undefined`) to keep conditional skills hidden.
   * Pass an empty array to explicitly say "we checked, nothing matched"
   * (same effect: conditional skills hidden, unconditional still active).
   * Skills WITHOUT `paths:` are always active regardless of this option.
   */
  candidateFiles?: readonly string[]
  /** Rewrites each project-scope disk skill before registration. */
  mapProjectSkill?: (skill: SkillDefinition) => SkillDefinition
  /** Rewrites/materializes the final merged skill set before filtering. */
  transformSkills?: (
    skills: SkillDefinition[],
  ) => SkillDefinition[] | Promise<SkillDefinition[]>
  /** Workspace cwd used only for `paths:` matching. Defaults to `cwd`. */
  filterCwd?: string
}

/**
 * Discover folder-based skills under `<ancestor>/.ai-agent/skills/<name>/SKILL.md`
 * (walked up from cwd to home) and `~/.ai-agent/skills/<name>/SKILL.md`,
 * then register (or replace) the `skill` dispatcher tool on the registry.
 *
 * If no skill folders are found we DO NOT register the tool — the model
 * shouldn't see an empty dispatcher (it would burn tokens on a useless
 * directory). Returns the active skill list so callers can decide what
 * to surface in UI.
 *
 * Mirrors `registerSubagents`: called once per chat request so user edits
 * to SKILL.md files take effect on the next turn without a server restart.
 */
export async function registerSkills(
  registry: IToolRegistry,
  cwd: string,
  forkableAgents: readonly AgentDefinition[],
  options: RegisterSkillsOptions = {},
): Promise<{
  /** All discovered skills, including conditional ones not active this turn. */
  allSkills: SkillDefinition[]
  /** Skills exposed to the model this turn (after `paths:` filtering). */
  activeSkills: SkillDefinition[]
  errors: Array<{ filePath: string; error: string }>
}> {
  let errors: Array<{ filePath: string; error: string }>
  let mergedSkills: SkillDefinition[]
  if (options.preloadedSkills) {
    errors = []
    mergedSkills = [...options.preloadedSkills]
  } else {
    const loaded = await loadSkillsFromDisk(cwd)
    errors = loaded.errors
    const mapProject = options.mapProjectSkill
    const diskSkills = mapProject
      ? loaded.skills.map(s => (s.source === 'project' ? mapProject(s) : s))
      : loaded.skills
    // Plugin skills first (lowest priority) → disk skills override on collision.
    mergedSkills = mergeSkillsByName(options.pluginSkills ?? [], diskSkills)
  }
  const skills = options.transformSkills
    ? await options.transformSkills(mergedSkills)
    : mergedSkills
  const activeSkills = filterSkillsByPaths(
    skills,
    options.candidateFiles,
    options.filterCwd ?? cwd,
  )

  if (activeSkills.length > 0) {
    registry.register(createSkillTool(activeSkills, forkableAgents))
  }

  return { allSkills: skills, activeSkills, errors }
}
