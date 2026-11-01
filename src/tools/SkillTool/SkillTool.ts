/**
 * Single dispatcher tool exposing all loaded skills. Mirrors the `task`
 * tool's "one tool, many subagent_types" pattern.
 *
 * The model calls `Skill({ skill, args })` and we either:
 *
 *   - inline:  expand the skill body ($ARGUMENTS / $1 / $name + !`shell` +
 *              @file), return `Launching skill: name` as the tool result,
 *              and inject the body as a meta user message.
 *
 *   - fork:    spin up a fresh subagent run with the expanded body as the
 *              system prompt. Used for skills that need many tool calls —
 *              keeps the main agent's context lean.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type {
  AgentDefinition,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import type { SkillDefinition } from '../../skills/types.js'
import { expandSkillBody, SkillExpansionError } from '../../skills/expand.js'
import { addInvokedSkill } from '../../skills/invoked-skills.js'
import { runSkillFork } from '../../skills/run-fork.js'

import { SKILL_TOOL_NAME } from '../../constants/tool_names.js'
import { getSkillToolPrompt } from './prompt.js'

export { SKILL_TOOL_NAME } from '../../constants/tool_names.js'

/**
 * The expanded body goes to the model as a meta user message; the card only
 * needs enough of it to inspect. Same cap the session UI puts on tool text.
 */
const UI_BODY_MAX_CHARS = 2_000

function uiBody(text: string): string {
  if (text.length <= UI_BODY_MAX_CHARS) return text
  return `${text.slice(0, UI_BODY_MAX_CHARS - 1)}…`
}

export function createSkillTool(
  skills: readonly SkillDefinition[],
  /**
   * Agents available for `context: fork` skills. The tool resolves
   * `skill.agent` (defaults to `general_purpose`) against this list to
   * find the right system-prompt scaffolding + tool subset. Pass the
   * same merged list you handed to `createTaskTool`.
   */
  forkableAgents: readonly AgentDefinition[],
): ToolDefinition {
  if (skills.length === 0) {
    throw new Error(
      'createSkillTool: at least one SkillDefinition required (none discovered)',
    )
  }

  const bySkill = new Map<string, SkillDefinition>()
  for (const s of skills) {
    if (bySkill.has(s.name)) {
      throw new Error(`Duplicate skill name '${s.name}'`)
    }
    bySkill.set(s.name, s)
  }
  const description = getSkillToolPrompt()

  return {
    name: SKILL_TOOL_NAME,
    description,
    // Surface as a subagent-style card in the UI when the skill is `fork`.
    // For inline skills the card style is still useful — it groups the
    // launch line visually.
    isSubagent: true,
    isConcurrencySafe: () => false,
    outputSchema: z.object({
      success: z.boolean().optional(),
      skill_name: z.string().optional(),
      mode: z.string().optional(),
      text: z.string().optional(),
      /** UI-only: expanded SKILL.md preview shown inside the skill card. */
      body: z.string().optional(),
      body_chars: z.number().optional(),
    }),
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const data = output as {
        skill_name?: string
        mode?: string
        text?: string
      }
      if (data.mode === 'fork') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: typeof data.text === 'string' ? data.text : '',
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Launching skill: ${data.skill_name ?? ''}`,
      }
    },
    create(cwd: string, context: ToolContext) {
      const { runAgent, eventBus, registry, toolEnablement } = context

      return tool({
        description,
        inputSchema: z.object({
          skill: z
            .string()
            .describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
          args: z
            .string()
            .optional()
            .describe('Optional arguments for the skill'),
        }),
        execute: async ({
          skill: rawSkill,
          args: rawArgs,
        }: {
          skill: string
          args?: string
        }) => {
          const trimmed = (rawSkill ?? '').trim()
          const skill_name = trimmed.startsWith('/')
            ? trimmed.slice(1)
            : trimmed
          const skill = bySkill.get(skill_name)
          if (!skill) {
            return `Unknown skill: ${skill_name}`
          }

          // Body load + arg substitution + `!`/`@`/`${SKILL_DIR}` expansion
          // are all delegated to skills/expand.ts so this dispatcher and
          // the HTTP-facing /skills/:name/invoke endpoint produce
          // identical output byte-for-byte.
          let combined: string
          try {
            const directiveRuntime =
              context.execution?.environmentId !== 'local'
                ? context.execution
                : undefined
            ;({ combined } = await expandSkillBody(
              skill,
              rawArgs ?? '',
              cwd,
              directiveRuntime,
            ))
          } catch (e) {
            if (e instanceof SkillExpansionError) return `Error: ${e.message}`
            throw e
          }

          // ── inline ── short tool_result + body as a meta message.
          if (skill.context === 'inline') {
            if (context.session) {
              addInvokedSkill(
                context.session,
                skill_name,
                skill.filePath ?? skill.baseDir ?? skill_name,
                combined,
                null,
              )
            }
            return {
              data: {
                success: true,
                skill_name,
                mode: 'inline' as const,
                body: uiBody(combined),
                body_chars: combined.length,
              },
              newMessages: [
                { role: 'user' as const, content: combined, isMeta: true },
              ],
            }
          }

          // ── fork ── dispatch as a subagent using the requested agent
          // type's system prompt + tool subset, but with the SKILL body
          // injected as the user prompt.
          //
          // This is the same machinery as `task`, condensed: we look up
          // the agent definition, build its tool surface (honoring
          // tools/disallowedTools), and call runAgent with the skill's
          // expanded body as the user message.
          if (!runAgent || !registry) {
            return `Error: skill fork requires runAgent + registry in ToolContext`
          }

          try {
            const text = await runSkillFork({
              skill,
              combined,
              cwd,
              runAgent,
              registry,
              activeAgents: forkableAgents,
              eventBus,
              wire: context.wire,
              toolEnablement,
              provider: context.provider,
              models: context.models,
              compaction: context.compaction,
              sessionId: context.sessionId,
              permissionContext: context.permissionContext,
              execution: context.execution,
            })
            return {
              data: {
                text: typeof text === 'string' ? text : String(text),
                skill_name,
                mode: 'fork',
              },
            }
          } catch (e) {
            return `Error: ${(e as Error).message}`
          }
        },
      })
    },
  }
}
