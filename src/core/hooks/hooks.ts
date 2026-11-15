/**
 * Runs the hooks configured for an event and folds their answers into one
 * result, following Claude Code's `utils/hooks.ts`:
 *
 *   exit 0            success; stdout is JSON when it starts with `{`
 *   exit 2            blocking: stderr goes back to the model (or the user)
 *   any other exit    a warning in the log; the event carries on
 *
 * Hooks of one event run in parallel. A hook that fails to start, times out
 * or prints JSON this file does not understand is logged and ignored: a
 * broken hook must not stop the agent.
 */
import {
  execCommandHook,
  type CommandHookResult,
  type ExecCommandHook,
} from './exec-command-hook.js'
import {
  hookJSONOutputSchema,
  type AggregatedHookResult,
  type HookCommand,
  type HookEvent,
  type HookInput,
  type HooksConfig,
} from './types.js'

/** Claude Code: TOOL_HOOK_EXECUTION_TIMEOUT_MS. */
export const HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

export type HookRunnerOptions = {
  hooks: HooksConfig | undefined
  cwd: string
  sessionId: string
  transcriptPath?: string
  /** Read at the time a hook runs, since the mode changes during a turn. */
  getPermissionMode?: () => string | undefined
  /** Replaces the process spawn in tests. */
  exec?: ExecCommandHook
}

export interface HookRunner {
  has(event: HookEvent): boolean
  preToolUse(
    args: { toolName: string; toolInput: unknown; toolUseId: string },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult>
  postToolUse(
    args: {
      toolName: string
      toolInput: unknown
      toolResponse: unknown
      toolUseId: string
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult>
  userPromptSubmit(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult>
  stop(
    stopHookActive: boolean,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult>
}

/**
 * The same hooks for a subagent: its tool calls run them, but it ending is
 * not the turn ending, so Stop hooks stay with the main agent.
 */
export function withoutStopHooks(runner: HookRunner): HookRunner {
  return {
    ...runner,
    has: event => event !== 'Stop' && runner.has(event),
    stop: async () => emptyResult('Stop'),
  }
}

function mergeResults(
  a: AggregatedHookResult,
  b: AggregatedHookResult,
): AggregatedHookResult {
  const permission =
    a.permissionBehavior &&
    (!b.permissionBehavior ||
      PERMISSION_RANK[a.permissionBehavior] >=
        PERMISSION_RANK[b.permissionBehavior])
      ? { behavior: a.permissionBehavior, reason: a.permissionReason }
      : { behavior: b.permissionBehavior, reason: b.permissionReason }
  return {
    hookName: a.hookName,
    blockingErrors: [...a.blockingErrors, ...b.blockingErrors],
    additionalContexts: [...a.additionalContexts, ...b.additionalContexts],
    outputs: [...a.outputs, ...b.outputs],
    preventContinuation: a.preventContinuation || b.preventContinuation,
    stopReason: a.stopReason ?? b.stopReason,
    systemMessages: [...a.systemMessages, ...b.systemMessages],
    ...(permission.behavior
      ? {
          permissionBehavior: permission.behavior,
          permissionReason: permission.reason,
        }
      : {}),
    ...(b.updatedInput || a.updatedInput
      ? { updatedInput: b.updatedInput ?? a.updatedInput }
      : {}),
  }
}

/** Both runners' hooks for every event, their answers taken together. */
export function combineHookRunners(
  a: HookRunner | undefined,
  b: HookRunner | undefined,
): HookRunner | undefined {
  if (!a || !b) return a ?? b
  const both = async (
    run: (runner: HookRunner) => Promise<AggregatedHookResult>,
  ) => {
    const [x, y] = await Promise.all([run(a), run(b)])
    return mergeResults(x, y)
  }
  return {
    has: event => a.has(event) || b.has(event),
    preToolUse: (args, signal) => both(r => r.preToolUse(args, signal)),
    postToolUse: (args, signal) => both(r => r.postToolUse(args, signal)),
    userPromptSubmit: (prompt, signal) =>
      both(r => r.userPromptSubmit(prompt, signal)),
    stop: (active, signal) => both(r => r.stop(active, signal)),
  }
}

/**
 * Whether a matcher selects the value (a tool name). Claude Code's
 * `matchesPattern`: empty or `*` is everything, plain names and `A|B` match
 * exactly, anything else is a regex.
 */
export function matchesPattern(matchQuery: string, matcher?: string): boolean {
  if (!matcher || matcher === '*') return true
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    return matcher
      .split('|')
      .map(part => part.trim())
      .includes(matchQuery)
  }
  try {
    return new RegExp(matcher).test(matchQuery)
  } catch {
    console.warn(`[hooks] invalid regex in hook matcher: ${matcher}`)
    return false
  }
}

function emptyResult(hookName: string): AggregatedHookResult {
  return {
    hookName,
    blockingErrors: [],
    additionalContexts: [],
    outputs: [],
    preventContinuation: false,
    systemMessages: [],
  }
}

const PERMISSION_RANK = { allow: 1, ask: 2, deny: 3 } as const

function setPermission(
  result: AggregatedHookResult,
  behavior: 'allow' | 'deny' | 'ask',
  reason: string | undefined,
): void {
  const current = result.permissionBehavior
  if (current && PERMISSION_RANK[current] >= PERMISSION_RANK[behavior]) return
  result.permissionBehavior = behavior
  result.permissionReason = reason
}

/** Folds one hook's JSON answer into the event's result. */
function applyJSONOutput(
  result: AggregatedHookResult,
  event: HookEvent,
  command: string,
  rawJson: unknown,
): void {
  const parsed = hookJSONOutputSchema.safeParse(rawJson)
  if (!parsed.success) {
    console.warn(
      `[hooks] ${result.hookName} [${command}] printed JSON that is not a hook answer: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    )
    return
  }
  const json = parsed.data
  const specific = json.hookSpecificOutput
  if (specific && specific.hookEventName !== event) {
    console.warn(
      `[hooks] ${result.hookName} [${command}] answered for ${specific.hookEventName}; ignored`,
    )
    return
  }

  if (json.continue === false) {
    result.preventContinuation = true
    if (json.stopReason) result.stopReason = json.stopReason
  }
  if (json.systemMessage) result.systemMessages.push(json.systemMessage)

  if (json.decision === 'approve') {
    setPermission(result, 'allow', json.reason)
  } else if (json.decision === 'block') {
    setPermission(result, 'deny', json.reason)
    result.blockingErrors.push({
      blockingError: json.reason || 'Blocked by hook',
      command,
    })
  }

  if (!specific) return
  if (event === 'PreToolUse') {
    const reason = specific.permissionDecisionReason ?? json.reason
    if (specific.permissionDecision === 'deny') {
      setPermission(result, 'deny', reason)
      if (json.decision !== 'block') {
        result.blockingErrors.push({
          blockingError: reason || 'Blocked by hook',
          command,
        })
      }
    } else if (specific.permissionDecision) {
      setPermission(result, specific.permissionDecision, reason)
    }
    if (specific.updatedInput) result.updatedInput = specific.updatedInput
  }
  if (specific.additionalContext) {
    result.additionalContexts.push(specific.additionalContext)
  }
}

function applyCommandResult(
  result: AggregatedHookResult,
  event: HookEvent,
  hook: HookCommand,
  outcome: CommandHookResult,
): void {
  const label = `${result.hookName} [${hook.command}]`
  if (outcome.aborted) return
  if (outcome.spawnError) {
    console.warn(`[hooks] ${label} could not start: ${outcome.spawnError}`)
    return
  }
  if (outcome.timedOut) {
    console.warn(`[hooks] ${label} timed out`)
    return
  }

  const stdout = outcome.stdout.trim()
  if (stdout.startsWith('{')) {
    let json: unknown
    try {
      json = JSON.parse(stdout)
    } catch {
      json = undefined
    }
    if (json !== undefined) {
      applyJSONOutput(result, event, hook.command, json)
      return
    }
  }

  if (outcome.status === 0) {
    if (stdout) result.outputs.push(stdout)
    return
  }
  if (outcome.status === 2) {
    result.blockingErrors.push({
      blockingError: `[${hook.command}]: ${outcome.stderr.trim() || 'No stderr output'}`,
      command: hook.command,
    })
    return
  }
  console.warn(
    `[hooks] ${label} failed with non-blocking status code ${outcome.status}: ${outcome.stderr.trim() || 'No stderr output'}`,
  )
}

export function createHookRunner(options: HookRunnerOptions): HookRunner {
  const { cwd, sessionId } = options
  const config = options.hooks ?? {}
  const exec = options.exec ?? execCommandHook

  const commandsFor = (
    event: HookEvent,
    matchQuery?: string,
  ): HookCommand[] => {
    const seen = new Set<string>()
    const commands: HookCommand[] = []
    for (const matcher of config[event] ?? []) {
      if (
        matchQuery !== undefined &&
        !matchesPattern(matchQuery, matcher.matcher)
      ) {
        continue
      }
      for (const hook of matcher.hooks) {
        // The same command listed by two settings files runs once.
        if (hook.type !== 'command' || seen.has(hook.command)) continue
        seen.add(hook.command)
        commands.push(hook)
      }
    }
    return commands
  }

  const run = async (
    event: HookEvent,
    matchQuery: string | undefined,
    eventInput: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> => {
    const hookName = matchQuery ? `${event}:${matchQuery}` : event
    const result = emptyResult(hookName)
    const commands = commandsFor(event, matchQuery)
    if (commands.length === 0) return result

    const input = {
      session_id: sessionId,
      transcript_path: options.transcriptPath ?? '',
      cwd,
      permission_mode: options.getPermissionMode?.(),
      hook_event_name: event,
      ...eventInput,
    } as HookInput
    const jsonInput = JSON.stringify(input)
    const env = {
      ...process.env,
      // Hook scripts written for Claude Code look for this name.
      CLAUDE_PROJECT_DIR: cwd,
      AGENT_PROJECT_DIR: cwd,
    }

    const outcomes = await Promise.all(
      commands.map(hook =>
        exec(hook.command, jsonInput, {
          cwd,
          env,
          signal,
          timeoutMs: hook.timeout
            ? hook.timeout * 1000
            : HOOK_EXECUTION_TIMEOUT_MS,
        }).catch((err): CommandHookResult => ({
          stdout: '',
          stderr: '',
          status: null,
          timedOut: false,
          aborted: false,
          spawnError: err instanceof Error ? err.message : String(err),
        })),
      ),
    )
    outcomes.forEach((outcome, index) => {
      applyCommandResult(result, event, commands[index]!, outcome)
    })
    for (const message of result.systemMessages) {
      console.warn(`[hooks] ${hookName}: ${message}`)
    }
    return result
  }

  return {
    has: event => (config[event]?.length ?? 0) > 0,
    preToolUse: ({ toolName, toolInput, toolUseId }, signal) =>
      run(
        'PreToolUse',
        toolName,
        { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId },
        signal,
      ),
    postToolUse: ({ toolName, toolInput, toolResponse, toolUseId }, signal) =>
      run(
        'PostToolUse',
        toolName,
        {
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          tool_use_id: toolUseId,
        },
        signal,
      ),
    userPromptSubmit: (prompt, signal) =>
      run('UserPromptSubmit', undefined, { prompt }, signal),
    stop: (stopHookActive, signal) =>
      run('Stop', undefined, { stop_hook_active: stopHookActive }, signal),
  }
}
