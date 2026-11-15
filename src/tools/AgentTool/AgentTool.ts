import { combineHookRunners, withoutStopHooks } from '../../core/hooks/hooks.js'
import { createSessionHookRunner } from '../../core/hooks/session-hooks.js'
import { withModeGate } from '../../utils/permissions/mode-restrictions.js'
import { isToolReadOnly } from '../../core/tool-definition.js'
import { isWorkerExecutionBackend } from '../../execution/worker-execution-backend.js'
import {
  createAgentWorktree,
  finishAgentWorktree,
  worktreeOutcomeText,
  type AgentWorktree,
  type WorktreeOutcome,
} from '../../utils/worktree.js'
import { connectAgentMcp, preloadSkillMessages } from './agentRuntime.js'
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import type {
  AgentDefinition,
  AgentOptions,
  AnyTool,
  Message,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import { createCanUseTool } from '../../utils/permissions/can-use-tool.js'
import { EventBus } from '../../core/event-bus.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import { isRemoteWorkspace } from '../../execution/index.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import { generateTaskId } from '../../Task.js'
import {
  asyncAgentLaunchedText,
  runAsyncAgentLifecycle,
} from './runAsyncAgent.js'
import {
  AGENT_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { EXPLORE_AGENT_TYPE } from './built-in/exploreAgent.js'
import { PLAN_AGENT_TYPE } from './built-in/planAgent.js'
import { loadAllAgentRules } from '../../utils/rules-loader.js'
import { enhanceSystemPromptWithEnvDetails } from '../../constants/prompts.js'
import { setCwd } from '../../utils/workspace/cwd.js'
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
import {
  appendSidechainMessage,
  appendSidechainTurnTiming,
  readSidechain,
  writeSidechainMeta,
} from '../../session/sidechain.js'
import { ensureToolResultPairing } from '../../core/agent/messageSanitize.js'

const SUBAGENT_STOPPED = 'Error: Subagent stopped by user.'

/** How an Agent call ended; `background` means it only launched the agent. */
const AGENT_RESULT_STATUSES = [
  'completed',
  'stopped',
  'error',
  'background',
] as const
type AgentResultStatus = (typeof AGENT_RESULT_STATUSES)[number]

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
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.
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
      /** The run's id: its transcript can be read and continued by it. */
      agentId: z.string().optional(),
      /** How the call ended, so the UI need not read it off the text. */
      status: z.enum(AGENT_RESULT_STATUSES).optional(),
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
          run_in_background: z
            .boolean()
            .optional()
            .describe(
              'Set to true to run this agent in the background. You will be notified when it completes.',
            ),
        }),
        execute: async (
          {
            subagent_type,
            description: shortDesc,
            prompt,
            run_in_background,
            resume,
          }: {
            subagent_type: string
            description: string
            prompt: string
            run_in_background?: boolean
            /** Agent id to continue from its transcript (SendMessage). */
            resume?: string
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
          const sessionId = context.sessionId ?? ''
          const prior = resume ? readSidechain(sessionId, resume) : null
          if (resume && !prior) {
            return `Error: no transcript for agent '${resume}'; it cannot be continued.`
          }

          if (!provider) {
            return 'Error: task tool requires provider in ToolContext'
          }

          // A background agent outlives this turn, so it cannot lean on what
          // the turn owns: it gets its own abort controller, event bus and
          // execution backend, and nowhere to stream to or ask on. Without
          // a session there is no queue to report back on, and a backend
          // that cannot be forked ends with the turn: run in the foreground.
          const background =
            (run_in_background === true || def.background === true) &&
            !!sessionId &&
            (!context.execution || !!context.execution.fork)
              ? {
                  abortController: new AbortController(),
                  eventBus: new EventBus(),
                  execution: context.execution?.fork?.(),
                  handedOver: false,
                }
              : undefined
          // Every subagent run has an id, so what it starts can be traced
          // back to it and cleaned up when it exits.
          const agentId = resume ?? generateTaskId('local_agent')
          const local =
            !isRemoteWorkspace(context.session?.workspace) &&
            !isWorkerExecutionBackend(context.execution)
          let worktree: AgentWorktree | undefined
          let isolationNote = ''
          const priorWorktree = prior?.meta.worktree
          if (priorWorktree && fs.existsSync(priorWorktree.path)) {
            worktree = priorWorktree
          } else if (
            priorWorktree ||
            (def.isolation === 'worktree' && !prior)
          ) {
            // A new agent, or one whose worktree was removed after its last
            // run for holding no changes. That one gets it back at the same
            // path, where the files it remembers were.
            if (!local) {
              isolationNote =
                'isolation: worktree needs a local git workspace; the agent worked in the shared one.'
            } else {
              try {
                worktree = await createAgentWorktree(cwd, agentId)
              } catch (err) {
                isolationNote = `No git worktree (${err instanceof Error ? err.message : String(err)}); the agent worked in the shared workspace.`
              }
            }
          }
          const agentCwd = worktree?.cwd ?? cwd
          let agentMcp: Awaited<ReturnType<typeof connectAgentMcp>> | undefined
          /**
           * What the run leaves behind, settled once: a note for whoever
           * reads the result, and the worktree when it was kept.
           */
          let finished:
            Promise<{ note: string; kept?: WorktreeOutcome }> | undefined
          const finishRun = () =>
            (finished ??= (async () => {
              await agentMcp?.close().catch(() => {})
              const outcome = worktree
                ? await finishAgentWorktree(worktree)
                : undefined
              return {
                note: [isolationNote, outcome && worktreeOutcomeText(outcome)]
                  .filter(Boolean)
                  .join('\n'),
                ...(outcome?.kept ? { kept: outcome } : {}),
              }
            })())
          const subExecution = background
            ? background.execution
            : context.execution
          const killAgentShells = () => {
            if (sessionId) {
              killShellTasksForAgent(sessionId, agentId, subExecution)
            }
          }
          try {
            const subWire = background
              ? noopWireEmitter
              : createSubagentWire(context.wire, resolvedParentId)
            const subEventBus = background?.eventBus ?? eventBus

            if (!background) {
              subWire.stepStart(0, {
                task: shortDesc.slice(0, 80),
                label: def.label || subagent_type,
                // Only a run with a session leaves a transcript to open.
                ...(sessionId ? { agentId } : {}),
              })
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
            if (
              sessionId &&
              (!prior ||
                (worktree && worktree !== priorWorktree) ||
                (subModel && subModel !== prior.meta.model))
            ) {
              writeSidechainMeta(sessionId, {
                ...(prior?.meta ?? {
                  agentId,
                  agentType: subagent_type,
                  description: shortDesc,
                  createdAt: Date.now(),
                }),
                ...(worktree ? { worktree } : {}),
                ...(subModel ? { model: subModel } : {}),
              })
            }

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
              ? worktree
                ? { ...context.permissionContext, root: path.resolve(agentCwd) }
                : context.permissionContext
              : undefined
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

            // Tool hooks apply to a subagent's calls; Stop is the main agent's.
            // The definition's own hooks run for this agent only, its Stop
            // hooks when it finishes.
            const subHooks = combineHookRunners(
              context.hooks ? withoutStopHooks(context.hooks) : undefined,
              def.hooks
                ? createSessionHookRunner({
                    hooks: def.hooks,
                    remote: !local,
                    cwd: agentCwd,
                    sessionId,
                    getPermissionMode: () => def.permissionMode,
                  })
                : undefined,
            )
            // Nobody can answer a prompt from an agent in the background.
            // A worktree is a root of its own; dontAsk refuses what would ask.
            const ownGate =
              context.canUseTool &&
              (background || worktree || def.permissionMode === 'dontAsk')
            const gate = ownGate
              ? createCanUseTool({
                  cwd: agentCwd,
                  getDefinition: name => registry.get(name),
                  permissionContext,
                  session: context.session,
                  wire: background ? noopWireEmitter : context.wire,
                  abortSignal: background?.abortController.signal,
                  shouldAvoidPermissionPrompts:
                    !!background || def.permissionMode === 'dontAsk',
                })
              : context.canUseTool
            const readOnlyMode =
              def.permissionMode === 'plan' || def.permissionMode === 'ask'
                ? def.permissionMode
                : undefined
            const subCanUseTool =
              gate && readOnlyMode
                ? withModeGate(
                    gate,
                    () => readOnlyMode,
                    name => isToolReadOnly(registry.get(name)),
                  )
                : gate
            const subContext: ToolContext = {
              eventBus: subEventBus,
              wire: subWire,
              registry,
              runAgent,
              toolEnablement,
              provider: subProvider,
              models,
              compaction,
              sessionId: context.sessionId,
              permissionContext,
              canUseTool: subCanUseTool,
              hooks: subHooks,
              cwd: worktree ? agentCwd : (context.cwd ?? cwd),
              mcpTools: context.mcpTools,
              execution: subExecution,
              autoMemory: context.autoMemory,
              agentId,
            }

            let subTools: Record<string, AnyTool>
            if (toolAllow) {
              subTools = registry.createAll(agentCwd, subContext, toolAllow)
            } else {
              subTools = registry.createAll(agentCwd, subContext)
              const patterns = def.disallowedTools ?? []
              for (const n of Object.keys(subTools)) {
                if (
                  n === AGENT_TOOL_NAME ||
                  isToolNameDisallowed(n, patterns)
                ) {
                  delete subTools[n]
                }
              }
            }
            delete subTools[AGENT_TOOL_NAME]
            delete subTools[SEND_MESSAGE_TOOL_NAME]
            if (def.mcpServers) {
              agentMcp = await connectAgentMcp(def.mcpServers, context.mcpTools)
              Object.assign(subTools, agentMcp.tools)
            }

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
              : loadAllAgentRules(agentCwd)
            const withRules = projectRules
              ? `${basePrompt}\n\n<project_rules>\nThe following rules were auto-loaded (user ~/.ai-agent/AGENTS.md, project AGENTS.md / .ai-agent/AGENTS.md / .ai-agent/rules/*.md, and AGENTS.local.md). They take precedence over all other sections when there is a conflict.\n\n${projectRules}\n</project_rules>`
              : basePrompt
            setCwd(agentCwd)
            const subSystemPrompt = (
              await enhanceSystemPromptWithEnvDetails(
                [withRules],
                subModel ?? '',
              )
            ).join('\n\n')
            if (worktree) setCwd(cwd)

            // Calls cut off when the agent last stopped get placeholder results.
            const subMessages: Message[] = prior
              ? ensureToolResultPairing(prior.messages)
              : def.skills
                ? await preloadSkillMessages(def.skills, agentCwd)
                : []
            if (sessionId && !prior) {
              for (const m of subMessages) {
                appendSidechainMessage(sessionId, agentId, m)
              }
            }
            // The span of the run goes on the message that opened it, so
            // the transcript can say how long the agent worked.
            const runSubagent = async (extra: Partial<AgentOptions>) => {
              const startTime = Date.now()
              let opening: string | undefined
              const onMessage = (message: Message) => {
                appendSidechainMessage(sessionId, agentId, message)
                if (
                  !opening &&
                  isRoleMessage(message) &&
                  message.role === 'user' &&
                  !message.isMeta
                ) {
                  opening = message.uuid
                }
              }
              try {
                return await runAgent(prompt, {
                  throwOnError: true,
                  tools: subTools,
                  systemPrompt: subSystemPrompt,
                  eventBus: subEventBus,
                  wire: subWire,
                  messages: subMessages,
                  ...(def.maxSteps !== undefined
                    ? { maxSteps: def.maxSteps }
                    : {}),
                  model: subModel,
                  provider: subProvider,
                  // A model the definition names explicitly is not swapped out.
                  ...(def.model === undefined
                    ? { fallbackProvider: models?.fallbackProvider(tier) }
                    : {}),
                  cwd: agentCwd,
                  compaction,
                  concurrencyPolicy: registry
                    ? buildConcurrencyPolicy(registry)
                    : undefined,
                  sessionId: context.sessionId,
                  getToolDefinition: name => registry.get(name),
                  canUseTool: subCanUseTool,
                  hooks: subHooks,
                  agentId,
                  ...(sessionId ? { onMessage } : {}),
                  ...extra,
                })
              } finally {
                if (opening) {
                  appendSidechainTurnTiming(
                    sessionId,
                    agentId,
                    opening,
                    startTime,
                    Date.now(),
                  )
                }
              }
            }

            if (background) {
              const task = registerAsyncAgent({
                sessionId,
                description: shortDesc,
                prompt,
                agentType: subagent_type,
                toolUseId: parentToolCallId,
                abortController: background.abortController,
                agentId,
              })
              const settleUsage = context.accountBackgroundUsage?.(
                background.eventBus,
              )
              background.handedOver = true
              void runAsyncAgentLifecycle({
                task,
                eventBus: background.eventBus,
                messages: subMessages,
                run: onStepCommitted =>
                  runSubagent({
                    abortSignal: background.abortController.signal,
                    onStepCommitted,
                  }),
                finishWorktree: async () => {
                  killAgentShells()
                  return (await finishRun()).kept
                },
                cleanup: async () => {
                  killAgentShells()
                  await finishRun()
                  background.execution?.dispose?.()
                  await settleUsage?.()
                },
              })
              return {
                data: {
                  text:
                    asyncAgentLaunchedText({
                      agentId: task.agentId,
                      outputFile: task.outputFile,
                      // The file is on this machine; a remote workspace's Read
                      // looks on the worker.
                      canReadOutputFile: !isRemoteWorkspace(
                        context.session?.workspace,
                      ),
                    }) +
                    (worktree
                      ? `\nIt works in a git worktree: ${worktree.path} (branch ${worktree.branch}); kept afterwards if it changed anything.`
                      : isolationNote && `\n${isolationNote}`),
                  agentId: task.agentId,
                  status: 'background' satisfies AgentResultStatus,
                },
              }
            }

            const abortSignal =
              options?.abortSignal ??
              (sessionId
                ? registerToolAbort(sessionId, resolvedParentId)
                : undefined)
            const output = (text: string, status: AgentResultStatus) => {
              const ui = buildAgentUiProjection(subMessages)
              return {
                data: {
                  text,
                  ...(sessionId ? { agentId } : {}),
                  status,
                  ...(ui ? { ui } : {}),
                },
              }
            }
            // However the run ended, the parent hears where its changes
            // are. Its shells go first: the worktree is judged by what is
            // in it once nothing writes to it any more.
            const withOutcome = async (text: string) => {
              killAgentShells()
              const { note } = await finishRun()
              return note ? `${text}\n\n${note}` : text
            }

            try {
              const result = await runSubagent({ abortSignal })

              if (abortSignal?.aborted) {
                return output(await withOutcome(SUBAGENT_STOPPED), 'stopped')
              }

              // Never hand the parent an empty tool_result —
              // some models treat that as "nothing to act on" and stop.
              const text = typeof result === 'string' ? result.trim() : ''
              const resumable = sessionId
                ? `\n\nagentId: ${agentId} (use ${SEND_MESSAGE_TOOL_NAME} with this id to continue this agent with its full context)`
                : ''
              return output(
                (await withOutcome(text || SUBAGENT_NO_OUTPUT_MARKER)) +
                  resumable,
                'completed',
              )
            } catch (err) {
              if (
                abortSignal?.aborted ||
                (err instanceof Error && err.name === 'AbortError')
              ) {
                return output(await withOutcome(SUBAGENT_STOPPED), 'stopped')
              }
              const message = err instanceof Error ? err.message : String(err)
              return output(await withOutcome(`Error: ${message}`), 'error')
            } finally {
              killAgentShells()
              if (sessionId && !options?.abortSignal) {
                clearToolAbort(sessionId, resolvedParentId)
              }
            }
          } finally {
            // Set up for the background but never launched.
            if (background && !background.handedOver) {
              background.execution?.dispose?.()
            }
            // A background agent finishes in its own lifecycle.
            if (!background?.handedOver) await finishRun()
          }
        },
      })
    },
  }
}
