/**
 * Prepare a chat turn before runAgent -- processUserInput pipeline.
 * Slash resolution, per-request registry reload, tools, mode restrictions.
 * Attachments collected in agent loop via getAttachmentMessages.
 */
import { dispatchSlashCommand } from '../../commands/dispatcher.js'
import { resolvePlanSlash } from '../../commands/plan.js'
import {
  registerSubagents,
  getSubagentNames,
} from '../../tools/AgentTool/index.js'
import {
  registerSkills,
  formatSkillListing,
  addInvokedSkill,
} from '../../skills/index.js'
import {
  loadPlugins,
  pluginErrorMessage,
  pluginErrorSource,
} from '../../core/plugins/index.js'
import { loadAllAgentRules, loadUserAgentRules } from '../rules-loader.js'
import { buildConcurrencyPolicy } from '../../core/concurrency-policy.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../constants/tool_names.js'
import { getPlanFilePath } from '../plans.js'
import type { ReadFileState } from '../read/types.js'
import {
  getExecutionPlane,
  resolveExecutionBackend,
} from '../../execution/index.js'
import { isCloudWorkspacesEnabled } from '../../execution/providers/cloud/config.js'
import type {
  AgentDefinition,
  AnyTool,
  IProvider,
  IToolRegistry,
  Session,
  ToolContext,
  ToolDefinition,
  ToolUseContext,
  AppConfig,
} from '../../core/types.js'
import type { ToolRegistry } from '../../core/tool-registry.js'
import type { SlashEntry } from '../../commands/slashRegistry.js'
import { extractFilePathCandidates } from './path_candidates.js'
import { mergeMCPServers } from '../../core/settings-manager.js'
import { noopWireEmitter, type WireEmitter } from '../../core/wire-emitter.js'
import type { TurnProfiler } from '../startupProfiler.js'
import { getMCPManagerForServers } from '../../core/mcp-lifecycle.js'
import {
  createFilesystemPermissionContext,
  settingsPermissionOpts,
} from '../permissions/filesystem.js'
import { resolveAutoMemoryConfig } from '../../core/settings-manager.js'
import {
  buildMemorySystemAppend,
  describeMemoryBinding,
  resolveMemoryBinding,
  type MemoryBinding,
} from '../../services/auto-memory/index.js'
import { findPrimaryAgent } from '../../tools/AgentTool/mergeAgents.js'
import { assembleToolPool } from '../../tools/assembleToolPool.js'
import { isBrowserEnabledForMainThread } from '../../browser/enablement.js'
import { warmExtensionRelay } from '../../browser/manager.js'
import { profileSpan } from '../startupProfiler.js'
import { loadSlashRegistry } from '../../commands/slashRegistry.js'
import type { DirectiveRuntime } from '../../commands/promptExpansion.js'
import type { SkillDefinition } from '../../skills/types.js'
import {
  materializeCloudSkills,
  requireShellFsPort,
} from '../../services/cloud-workspaces/skill-materializer.js'
import {
  filterCloudMCPServers,
  resolveTurnWorkspaceScope,
} from '../../services/cloud-workspaces/turn-scope.js'

export type ForkSkillSlashResult = {
  kind: 'run'
  mode: 'fork'
  text: string
  entry: Extract<SlashEntry, { kind: 'skill' }>
}

export interface SlashResolution {
  effectiveMessage: string
  immediateReply: string | null
  forkSkill: ForkSkillSlashResult | null
  /** Set when the user ran `/compact [instructions]`; handled by the chat route. */
  manualCompact: { instructions: string } | null
  /** Set when the user ran `/summary`; force session-memory extract. */
  forceSummary: boolean
  modeChanged?: boolean
}

export interface ResolveSlashCommandOptions {
  preloaded?: { entries: SlashEntry[] }
  extensionCwd?: string
  directiveRuntime?: DirectiveRuntime
}

export async function resolveSlashCommand(
  message: string,
  cwd: string,
  session?: Session,
  options: ResolveSlashCommandOptions = {},
): Promise<SlashResolution> {
  if (session) {
    const planSlash = resolvePlanSlash(message, session, cwd)
    if (planSlash.handled) {
      return {
        effectiveMessage: planSlash.effectiveMessage ?? message,
        immediateReply: planSlash.immediateReply ?? null,
        forkSkill: null,
        manualCompact: null,
        forceSummary: false,
        modeChanged: planSlash.modeChanged,
      }
    }
  }

  const slashResult = await dispatchSlashCommand(
    message,
    {
      cwd,
      extensionCwd: options.extensionCwd,
      directiveRuntime: options.directiveRuntime,
    },
    options.preloaded,
  )
  let effectiveMessage = message
  let immediateReply: string | null = null
  let forkSkill: SlashResolution['forkSkill'] = null
  let manualCompact: SlashResolution['manualCompact'] = null
  let forceSummary = false

  if (slashResult.kind === 'reply') {
    immediateReply = slashResult.text
  } else if (slashResult.kind === 'compact') {
    manualCompact = { instructions: slashResult.instructions }
  } else if (slashResult.kind === 'summary') {
    forceSummary = true
  } else if (slashResult.kind === 'unknown') {
    immediateReply = `Unknown slash command: /${slashResult.name}\n\nTry /help to see all available commands.`
  } else if (slashResult.kind === 'run' && slashResult.mode === 'inline') {
    effectiveMessage = slashResult.text
    if (session && slashResult.entry.kind === 'skill') {
      const def = slashResult.entry.def
      addInvokedSkill(
        session,
        def.name,
        def.filePath ?? def.baseDir ?? def.name,
        slashResult.text,
      )
    }
    console.log(
      `[server] expanded /${slashResult.entry.name} (${slashResult.entry.kind}) -> ${effectiveMessage.length} char prompt`,
    )
  } else if (
    slashResult.kind === 'run' &&
    slashResult.mode === 'fork' &&
    slashResult.entry.kind === 'skill'
  ) {
    forkSkill = slashResult as ForkSkillSlashResult
  }

  return {
    effectiveMessage,
    immediateReply,
    forkSkill,
    manualCompact,
    forceSummary,
  }
}

export interface PreparedChatTurn {
  effectiveMessage: string
  immediateReply: string | null
  forkSkill: SlashResolution['forkSkill']
  manualCompact: SlashResolution['manualCompact']
  forceSummary: boolean
  tools: Record<string, AnyTool>
  /** Tools before mode filtering -- used to refresh when mode changes mid-turn. */
  baseTools: Record<string, AnyTool>
  modeTools: Record<string, AnyTool>
  deferredToolPool?: Record<string, AnyTool>
  /** Per-turn dynamic defs first, then the registry. */
  getToolDefinition: (name: string) => ToolDefinition | undefined
  projectRules: string
  /** Resolved once per turn; prompt / roots / prefetch / extract all consume this. */
  memoryBinding: MemoryBinding
  /** Standalone memory guide (private primary). Empty when it rides in projectRules. */
  memoryPromptSegment: string
  toolUseContext: ToolUseContext
  subagentNames: Set<string>
  concurrencyPolicy: ReturnType<typeof buildConcurrencyPolicy>
  permissionMode: Session['permissionMode']['mode']
  /** Resolved primary profile for this turn, if any. */
  mainThreadProfile: AgentDefinition | null
  denyGlobs?: string[]
  planFilePath: string
  modeChanged?: boolean
  toolContext: ToolContext
}

export interface PrepareChatTurnInput {
  message: string
  cwd: string
  session: Session
  registry: IToolRegistry
  config: AppConfig
  provider: IProvider
  models?: ToolContext['models']
  eventBus: ToolContext['eventBus']
  middleware: ToolContext['middleware']
  runAgent: NonNullable<ToolContext['runAgent']>
  wire?: WireEmitter
  turnProfiler?: TurnProfiler
}

export async function prepareChatTurn(
  input: PrepareChatTurnInput,
): Promise<PreparedChatTurn> {
  const {
    message,
    cwd,
    session,
    registry,
    config,
    provider,
    models,
    eventBus,
    middleware,
    runAgent,
    wire = noopWireEmitter,
    turnProfiler,
  } = input

  const turnScope = resolveTurnWorkspaceScope(session.workspace, cwd)
  const cloudWorkspaceId = turnScope.cloudWorkspaceId
  const cloudSession = cloudWorkspaceId !== null
  const remote = turnScope.remote
  const extensionCwd = turnScope.extensionCwd
  if (isCloudWorkspacesEnabled() && !cloudSession) {
    throw new Error(
      'This chat is not bound to a cloud workspace. Start a new chat in a workspace.',
    )
  }

  // Resolve once before any slash/Skill expansion. Remote failure must never
  // make directives fall back to control-plane shell or filesystem access.
  let execution
  try {
    const runtimeHandle = session.workspace ?? {
      environmentId: 'local',
      cwd,
    }
    const runtimeCache = getExecutionPlane().runtimes.get(runtimeHandle)
      ? 'hot'
      : 'cold'
    wire.turnState('preparing', 'execution.resolve', 'Preparing environment')
    execution = await profileSpan('turn_execution_backend', () =>
      resolveExecutionBackend(session, config.lspServers),
    )
    turnProfiler?.checkpoint('execution_ready', {
      workspace: remote ? 'remote' : 'local',
      runtime_cache: runtimeCache,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] execution backend resolve failed:`, msg)
    if (remote) {
      throw new Error(
        `Remote execution backend unavailable (${session.workspace?.environmentId}): ${msg}. ` +
          `Shell/file tools cannot fall back to the local machine.`,
        { cause: err },
      )
    }
    execution = undefined
  }
  const directiveRuntime = remote ? execution : undefined

  let cloudSkillPortPromise:
    Promise<ReturnType<typeof requireShellFsPort>> | undefined
  const transformCloudSkills = cloudSession
    ? async (skills: SkillDefinition[]): Promise<SkillDefinition[]> => {
        if (
          !session.workspace ||
          !cloudWorkspaceId ||
          !turnScope.extensionRoot
        ) {
          throw new Error('Cloud skill materialization has no workspace')
        }
        return skills.map(skill => {
          if (
            (skill.source !== 'user' && skill.source !== 'plugin') ||
            !skill.baseDir
          ) {
            return skill
          }
          let prepared: Promise<string | undefined> | undefined
          return {
            ...skill,
            prepareRuntimeBaseDir: () => {
              if (prepared) return prepared
              prepared = profileSpan(
                'turn_cloud_skill_materialize',
                async () => {
                  wire.turnState(
                    'preparing',
                    'skills.materialize',
                    `Loading ${skill.name}`,
                  )
                  cloudSkillPortPromise ??= getExecutionPlane()
                    .workspaces.ensureFs(session.workspace!.environmentId)
                    .then(requireShellFsPort)
                  const snapshot = await materializeCloudSkills({
                    workspaceId: cloudWorkspaceId,
                    skills: [skill],
                    port: await cloudSkillPortPromise,
                    sourceRoot: turnScope.extensionRoot,
                  })
                  const skipped = snapshot.skipped.find(
                    item => item.name === skill.name,
                  )
                  if (skipped) {
                    throw new Error(
                      `Skill "${skill.name}" could not be loaded: ${skipped.error}`,
                    )
                  }
                  return snapshot.skills[0]?.runtimeBaseDir
                },
              )
              return prepared
            },
          }
        })
      }
    : undefined

  const preloadedSlash =
    cloudSession && message.trimStart().startsWith('/')
      ? await loadSlashRegistry(extensionCwd, {
          transformSkills: transformCloudSkills,
        })
      : undefined
  const slash = await resolveSlashCommand(message, cwd, session, {
    preloaded: preloadedSlash,
    extensionCwd,
    directiveRuntime,
  })

  // Plugins/skills/MCP load from a local tree. Remote sessions still use the
  // Control Plane machine's default workspace for that — tools use remote cwd.
  // Cloud sessions use only the request-scoped tenant home.
  wire.turnState('preparing', 'extensions.load', 'Loading extensions')
  const plugins = await loadPlugins(extensionCwd)
  if (plugins.plugins.length > 0) {
    console.log(
      `[server] plugins=[${plugins.plugins.map(p => p.name).join(', ')}] ` +
        `(+${plugins.agentFiles.length} agents, ${plugins.skills.length} skills, ` +
        `${Object.keys(plugins.mcpServers).length} mcp)`,
    )
  }
  for (const e of plugins.errors) {
    console.warn(`[plugins] ${pluginErrorSource(e)}: ${pluginErrorMessage(e)}`)
  }
  const { activeAgents } = await registerSubagents(
    registry,
    extensionCwd,
    plugins.agentFiles,
  )
  const candidateFiles = extractFilePathCandidates(slash.effectiveMessage)
  const { activeSkills, allSkills } = await registerSkills(
    registry,
    extensionCwd,
    activeAgents,
    {
      candidateFiles,
      pluginSkills: preloadedSlash ? undefined : plugins.skills,
      preloadedSkills: preloadedSlash?.skills,
      transformSkills: preloadedSlash ? undefined : transformCloudSkills,
      filterCwd: cloudSession ? cwd : undefined,
    },
  )
  const conditionalHidden = allSkills.length - activeSkills.length
  turnProfiler?.checkpoint('extensions_ready', {
    agents: activeAgents.length,
    skills: activeSkills.length,
  })
  console.log(
    `[server] cwd=${cwd}${remote ? ` remote=${session.workspace?.environmentId}` : ''}  agents=[${activeAgents.map(a => a.agentType).join(', ')}]  skills=[${activeSkills.map(s => s.name).join(', ')}]${conditionalHidden > 0 ? `  (+${conditionalHidden} conditional hidden)` : ''}`,
  )

  let mcpServers = mergeMCPServers(plugins.mcpServers, config.mcpServers)
  if (cloudSession) {
    const filtered = filterCloudMCPServers(mcpServers)
    mcpServers = filtered.servers
    if (filtered.dropped.length > 0) {
      console.warn(
        `[mcp] cloud turn skipped non-HTTP servers: ${filtered.dropped.join(', ')}`,
      )
    }
  }
  wire.turnState('preparing', 'mcp.connect', 'Connecting integrations')
  const mcpManager = await getMCPManagerForServers(extensionCwd, mcpServers)
  turnProfiler?.checkpoint('mcp_ready', {
    configured: Object.keys(mcpServers).length,
    connected: mcpManager.connectedCount,
  })

  const projectRulesRaw = cloudSession
    ? loadUserAgentRules()
    : remote
      ? ''
      : loadAllAgentRules(cwd)
  const autoMemory = resolveAutoMemoryConfig(config)
  const earlyProfile = findPrimaryAgent(activeAgents, session.agentType)
  const memoryBinding = resolveMemoryBinding({
    cwd: extensionCwd,
    config: autoMemory,
    profile: earlyProfile,
    agents: activeAgents,
    queryText: slash.effectiveMessage,
    remote,
  })
  const memoryGuide = buildMemorySystemAppend(memoryBinding)
  const projectRules =
    memoryBinding.prompt.placement === 'project-rules'
      ? [projectRulesRaw, memoryGuide].filter(s => s.trim()).join('\n\n')
      : projectRulesRaw
  const memoryPromptSegment =
    memoryBinding.prompt.placement === 'standalone' ? memoryGuide : ''
  console.log(`[server] ${describeMemoryBinding(memoryBinding)}`)
  const toolEnablement = {
    disabledTools: [
      ...(config.disabledTools ?? []),
      // PowerShell is host-local; remote SSH always uses bash.
      ...(remote ? ['powershell'] : []),
    ],
  }

  const permOpts = settingsPermissionOpts(config.permissions)

  const toolContext: ToolContext = {
    eventBus,
    wire: noopWireEmitter,
    middleware,
    runAgent,
    registry,
    mcpTools: mcpManager.getAllTools(),
    toolEnablement,
    provider,
    models,
    compaction: config.compaction,
    sessionMemory: config.sessionMemory,
    autoMemory,
    lspServers: config.lspServers,
    sessionId: session.id,
    session,
    cwd,
    // Cloud cwd is a POSIX path inside the container, the real boundary; SSH
    // keeps the local root because a Win32 control plane mangles POSIX paths.
    permissionContext: createFilesystemPermissionContext(
      remote && !cloudSession ? extensionCwd : cwd,
      {
        extraReadRoots:
          memoryBinding.roots.read.length > 0
            ? memoryBinding.roots.read
            : undefined,
        extraWriteRoots:
          memoryBinding.roots.write.length > 0
            ? memoryBinding.roots.write
            : undefined,
        ...permOpts,
        additionalWorkingDirectories: [
          ...(permOpts.additionalWorkingDirectories ?? []),
          ...(session.additionalWorkingDirectories ?? []),
        ],
      },
    ),
    execution,
  }

  const pool = assembleToolPool({
    registry: registry as ToolRegistry,
    cwd,
    session,
    toolContext,
    mcpTools: mcpManager.getAllTools(),
    activeAgents,
    toolEnablement,
    browserConfig: config.browser,
  })

  if (
    isBrowserEnabledForMainThread(
      pool.mainThreadProfile?.agentType ?? session.agentType,
      config.browser,
    ) &&
    (config.browser?.mode === 'extension' || config.browser?.mode === 'auto')
  ) {
    warmExtensionRelay(cwd)
  }

  const reminderParts: string[] = []
  if (cloudSession && session.workspace) {
    const environmentId = encodeURIComponent(session.workspace.environmentId)
    reminderParts.push(
      `This turn runs in cloud environment \`${session.workspace.environmentId}\`. ` +
        'For an HTML or image artifact in this environment, use this same-origin URL form: ' +
        `\`/workspace/preview?environmentId=${environmentId}&path={encodeURIComponent(absolutePath)}\`. ` +
        'Return HTML as a Markdown link and images as Markdown image syntax (`![alt](URL)`) so they render inline. ' +
        'Generate a PNG only when the user explicitly requests one; interactive HTML preview does not require Chrome or Playwright.',
    )
  }
  if (activeSkills.length > 0) {
    reminderParts.push(
      `The following skills are available for use with the Skill tool:\n\n${formatSkillListing(activeSkills)}`,
    )
  }
  if (pool.deferredDefs.length > 0) {
    const listing = pool.deferredDefs
      .map(
        (d: { name: string; description: string; isMcp: boolean }) =>
          `- ${d.name}${d.isMcp ? ' (MCP)' : ''}`,
      )
      .join('\n')
    reminderParts.push(
      `The following tools are available but not loaded. Use \`${TOOL_SEARCH_TOOL_NAME}\` to discover and load them before use:\n${listing}`,
    )
  }

  console.log(
    `[server] mode=${session.permissionMode.mode}${pool.mainThreadProfile ? ` agentType=${pool.mainThreadProfile.agentType}` : ''} tools: ${Object.keys(pool.tools).length} active, ${pool.deferredDefs.length} deferred${session.discoveredTools?.size ? `, ${session.discoveredTools.size} previously discovered` : ''}`,
  )

  if (!session.readFileState) {
    session.readFileState = new Map()
  }
  const readFileState = session.readFileState as ReadFileState

  const toolUseContext: ToolUseContext = {
    cwd,
    session,
    readFileState,
    lspServers: config.lspServers,
    options: { tools: pool.tools },
    skillListingContent:
      reminderParts.length > 0 ? reminderParts.join('\n\n') : undefined,
    agentDefinitions: { activeAgents },
    conditionalRulesEnabled:
      !remote && pool.mainThreadProfile?.omitProjectRules !== true,
  }

  const planFilePath = getPlanFilePath(session, cwd)

  return {
    effectiveMessage: slash.effectiveMessage,
    immediateReply: slash.immediateReply,
    forkSkill: slash.forkSkill,
    manualCompact: slash.manualCompact,
    forceSummary: slash.forceSummary,
    tools: pool.tools,
    baseTools: pool.baseTools,
    modeTools: pool.modeTools,
    deferredToolPool: pool.deferredToolPool,
    getToolDefinition: (name: string) =>
      pool.dynamicDefs[name] ?? registry.get(name),
    projectRules,
    memoryBinding,
    memoryPromptSegment,
    toolUseContext,
    subagentNames: getSubagentNames(registry),
    concurrencyPolicy: buildConcurrencyPolicy(registry),
    permissionMode: session.permissionMode.mode,
    mainThreadProfile: pool.mainThreadProfile,
    denyGlobs: pool.denyGlobs,
    planFilePath,
    modeChanged: slash.modeChanged,
    toolContext,
  }
}
