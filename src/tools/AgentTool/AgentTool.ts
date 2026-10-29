import { tool } from 'ai'
import { z } from 'zod'
import path from 'path'
import type {
  AgentDefinition,
  AnyTool,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import {
  AGENT_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { EXPLORE_AGENT_TYPE } from './built-in/exploreAgent.js'
import { PLAN_AGENT_TYPE } from './built-in/planAgent.js'
import { loadAllAgentRules } from '../../utils/rules-loader.js'
import { enhanceSystemPromptWithEnvDetails } from '../../constants/prompts.js'
import { setCwd } from '../../utils/cwd.js'
import { buildConcurrencyPolicy } from '../../core/concurrency-policy.js'
import { createSubagentWire } from '../../core/brokers/subagent-wire.js'
import { randomUUID } from 'crypto'

import { buildAgentListSection } from './agentListing.js'
import { SUBAGENT_NO_OUTPUT_MARKER } from './finalizeAgentTool.js'
import { isToolNameDisallowed } from './toolGlob.js'
import {
  clearToolAbort,
  registerToolAbort,
} from '../../core/tool-abort-registry.js'
import { getAgentMemoryDir, loadAgentMemoryPrompt } from './agentMemory.js'
import { buildAgentUiProjection } from './uiProjection.js'

const SUBAGENT_STOPPED = 'Error: Subagent stopped by user.'

/** tools/AgentTool/AgentTool.tsx — single dispatcher for all subagents. */
export function createTaskTool(
  agents: readonly AgentDefinition[],
): ToolDefinition {
  if (agents.length === 0) {
    throw new Error('createTaskTool: at least one AgentDefinition required')
  }

  const byType = new Map<string, AgentDefinition>()
  for (const a of agents) {
    if (byType.has(a.agentType)) {
      throw new Error(`Duplicate agentType '${a.agentType}' in BUILTIN_AGENTS`)
    }
    byType.set(a.agentType, a)
  }
  const validTypes = [...byType.keys()]

  const agentListSection = buildAgentListSection(agents)

  const description = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

When using the ${AGENT_TOOL_NAME} tool, specify a \`subagent_type\` parameter to select which agent type to use.

When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use \`${FILE_READ_TOOL_NAME}\` or \`${GLOB_TOOL_NAME}\` instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use \`${GLOB_TOOL_NAME}\` instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use \`${FILE_READ_TOOL_NAME}\` instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
- Always include a short \`description\` (3-5 words) summarizing what the agent will do.
- You can issue several \`${AGENT_TOOL_NAME}\` calls in one response to dispatch independent agents in parallel. If the user says "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks.
- Each invocation starts fresh — the subagent does NOT see your prior conversation. The \`prompt\` must be self-contained.
- The subagent returns a single final report. The result is NOT visible to the user — summarize the relevant parts in your own reply.
- The subagent's outputs should generally be trusted. Don't re-run the same searches yourself.
- Clearly tell the subagent whether you expect it to write code or just research, since it is not aware of the user's intent.
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.

Writing the prompt — brief the subagent like a smart colleague who just walked into the room. They have not seen this conversation, do not know what you've tried, do not understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- Be specific about scope and the form of answer you want ("report in under 200 words", "list of file:line citations").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- Never delegate understanding. Don't write "based on your findings, fix the bug" — that pushes synthesis onto the subagent. Write prompts that prove you understood: file paths, line numbers, what specifically to change.

Terse command-style prompts produce shallow, generic work.

Examples:

<example_agent_descriptions>
"${EXPLORE_AGENT_TYPE}": use this agent for exploring and understanding codebases
"${PLAN_AGENT_TYPE}": use this agent to design implementation plans before writing code
</example_agent_descriptions>

<example>
user: "Where is the SSE transport implemented and how does it stream tool events?"
<commentary>
This is a broad "how does X work" question across multiple files. Use the ${EXPLORE_AGENT_TYPE} agent since it will require searching many files.
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the ${EXPLORE_AGENT_TYPE} agent with a detailed prompt explaining what to find.
</example>

<example>
user: "Refactor the agent loop to support cancellation."
<commentary>
Non-trivial architecture change. Use the ${PLAN_AGENT_TYPE} agent to explore and design first, then implement.
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the ${PLAN_AGENT_TYPE} agent
</example>`

  return {
    name: AGENT_TOOL_NAME,
    description,
    isSubagent: true,
    // Explore is read-only — safe to run several in parallel.
    // Plan / general-purpose stay serial.
    isConcurrencySafe: (input: unknown) => {
      const t =
        input && typeof input === 'object'
          ? (input as { subagent_type?: string }).subagent_type
          : undefined
      return t === EXPLORE_AGENT_TYPE || t === 'explore'
    },
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const text = (output as { text: string }).text
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: text,
        ...(text.startsWith('Error:') ? { is_error: true } : {}),
      }
    },
    outputSchema: z.object({
      text: z.string(),
      ui: z
        .object({
          version: z.literal(1),
          steps: z.array(
            z.object({
              type: z.literal('tool_call'),
              toolCallId: z.string(),
              name: z.string(),
              args: z.record(z.string(), z.unknown()),
              status: z.literal('done'),
              result: z.string().optional(),
              toolUseResult: z.unknown().optional(),
              isError: z.boolean().optional(),
            }),
          ),
          omittedSteps: z.number().int().nonnegative().optional(),
          detailsTruncated: z.literal(true).optional(),
        })
        .optional(),
    }),
    create(cwd: string, context: ToolContext) {
      const {
        runAgent,
        eventBus,
        registry,
        toolEnablement,
        provider,
        models,
        compaction,
      } = context

      return tool({
        description,
        inputSchema: z.object({
          subagent_type: z
            .enum(validTypes as [string, ...string[]])
            .describe(
              'Which subagent to dispatch to. Must be one of the registered agent types.',
            ),
          description: z
            .string()
            .min(1)
            .describe('Short 3-5 word title for the task, shown in the UI.'),
          prompt: z
            .string()
            .min(1)
            .describe(
              'Self-contained, detailed task description. The subagent does NOT see prior conversation, so include all needed context, file paths, and what to return.',
            ),
        }),
        execute: async (
          {
            subagent_type,
            description: shortDesc,
            prompt,
          }: {
            subagent_type: string
            description: string
            prompt: string
          },
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ) => {
          const def = byType.get(subagent_type)
          if (!def) {
            return `Error: unknown subagent_type '${subagent_type}'. Valid: ${validTypes.join(', ')}`
          }

          if (context.session?.permissionMode.mode === 'plan') {
            const allowedInPlan = new Set([EXPLORE_AGENT_TYPE, PLAN_AGENT_TYPE])
            if (!allowedInPlan.has(subagent_type)) {
              return (
                `Error: plan mode only allows ${EXPLORE_AGENT_TYPE} (Phase 1) and ` +
                `${PLAN_AGENT_TYPE} (Phase 2) subagents. Got '${subagent_type}'.`
              )
            }
          }
          if (!runAgent || !registry) {
            return `Error: task tool requires runAgent + registry in ToolContext`
          }

          const parentToolCallId = options?.toolCallId
          if (!parentToolCallId) {
            console.warn(
              `[Agent] missing toolCallId for subagent ${subagent_type} — nested UI routing may be wrong`,
            )
          }
          const resolvedParentId = parentToolCallId ?? randomUUID()
          const subWire = createSubagentWire(context.wire, resolvedParentId)

          subWire.stepStart(0, {
            task: shortDesc.slice(0, 80),
            label: def.label || subagent_type,
          })

          if (!provider) {
            return 'Error: task tool requires provider in ToolContext'
          }

          const tier = def.modelTier ?? 'large'
          const subProvider = models?.provider(tier) ?? provider
          if (!subProvider) {
            throw new Error(
              `Subagent '${subagent_type}' requires a request-scoped provider`,
            )
          }
          const subModel =
            def.model ??
            models?.profile(tier).model ??
            subProvider.defaultModelId()

          const autoMemOn = context.autoMemory?.enabled !== false
          const agentMemEnabled = Boolean(autoMemOn && def.memory)

          const toolAllow = def.tools ? [...def.tools] : undefined
          if (agentMemEnabled && toolAllow) {
            for (const name of [
              WRITE_FILE_TOOL_NAME,
              EDIT_FILE_TOOL_NAME,
              FILE_READ_TOOL_NAME,
            ]) {
              if (!toolAllow.includes(name)) toolAllow.push(name)
            }
          }

          const agentMemDir =
            agentMemEnabled && def.memory
              ? getAgentMemoryDir(subagent_type, def.memory, cwd)
              : undefined

          const parentPerm = context.permissionContext
          const permissionContext =
            agentMemDir && parentPerm
              ? {
                  ...parentPerm,
                  extraReadRoots: [
                    ...parentPerm.extraReadRoots,
                    path.resolve(agentMemDir),
                  ],
                  extraWriteRoots: [
                    ...parentPerm.extraWriteRoots,
                    path.resolve(agentMemDir),
                  ],
                }
              : parentPerm

          const subContext: ToolContext = {
            eventBus,
            wire: subWire,
            registry,
            runAgent,
            toolEnablement,
            provider: subProvider,
            models,
            compaction,
            sessionId: context.sessionId,
            permissionContext,
            cwd: context.cwd ?? cwd,
            execution: context.execution,
            autoMemory: context.autoMemory,
          }

          let subTools: Record<string, AnyTool>
          if (toolAllow) {
            subTools = registry.createAll(cwd, subContext, toolAllow)
          } else {
            subTools = registry.createAll(cwd, subContext)
            const patterns = def.disallowedTools ?? []
            for (const n of Object.keys(subTools)) {
              if (n === AGENT_TOOL_NAME || isToolNameDisallowed(n, patterns)) {
                delete subTools[n]
              }
            }
          }
          delete subTools[AGENT_TOOL_NAME]

          let basePrompt = def.systemPrompt
          if (agentMemEnabled && def.memory) {
            basePrompt = `${def.systemPrompt}\n\n${loadAgentMemoryPrompt(
              subagent_type,
              def.memory,
              cwd,
              def.memoryPolicy?.vocabulary,
            )}`
          }

          const projectRules = def.omitProjectRules
            ? ''
            : loadAllAgentRules(cwd)
          const withRules = projectRules
            ? `${basePrompt}\n\n<project_rules>\nThe following rules were auto-loaded (user ~/.ai-agent/AGENTS.md, project AGENTS.md / .ai-agent/AGENTS.md / .ai-agent/rules/*.md, and AGENTS.local.md). They take precedence over all other sections when there is a conflict.\n\n${projectRules}\n</project_rules>`
            : basePrompt
          setCwd(cwd)
          const subSystemPrompt = (
            await enhanceSystemPromptWithEnvDetails([withRules], subModel ?? '')
          ).join('\n\n')

          const sessionId = context.sessionId ?? ''
          const abortSignal =
            options?.abortSignal ??
            (sessionId
              ? registerToolAbort(sessionId, resolvedParentId)
              : undefined)
          const subMessages: import('../../core/types.js').Message[] = []
          const output = (text: string) => {
            const ui = buildAgentUiProjection(subMessages)
            return { data: { text, ...(ui ? { ui } : {}) } }
          }

          try {
            const result = await runAgent(prompt, {
              throwOnError: true,
              tools: subTools,
              systemPrompt: subSystemPrompt,
              eventBus,
              wire: subWire,
              messages: subMessages,
              ...(def.maxSteps !== undefined ? { maxSteps: def.maxSteps } : {}),
              model: subModel,
              provider: subProvider,
              cwd,
              compaction,
              concurrencyPolicy: registry
                ? buildConcurrencyPolicy(registry)
                : undefined,
              sessionId: context.sessionId,
              abortSignal,
            })

            if (abortSignal?.aborted) {
              return output(SUBAGENT_STOPPED)
            }

            // Never hand the parent an empty tool_result —
            // some models treat that as "nothing to act on" and stop.
            const text = typeof result === 'string' ? result.trim() : ''
            return output(text || SUBAGENT_NO_OUTPUT_MARKER)
          } catch (err) {
            if (
              abortSignal?.aborted ||
              (err instanceof Error && err.name === 'AbortError')
            ) {
              return output(SUBAGENT_STOPPED)
            }
            const message = err instanceof Error ? err.message : String(err)
            return output(`Error: ${message}`)
          } finally {
            if (sessionId && !options?.abortSignal) {
              clearToolAbort(sessionId, resolvedParentId)
            }
          }
        },
      })
    },
  }
}
