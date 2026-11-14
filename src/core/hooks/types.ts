/**
 * User-configured lifecycle hooks, in the format Claude Code uses in its
 * `settings.json`:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./check.sh" }] }
 *     ]
 *   }
 *
 * A hook command receives the event as JSON on stdin and answers with its
 * exit code (0 ok, 2 block, anything else a warning) or with JSON on stdout.
 */
import { z } from 'zod'

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export type HookCommand = {
  type: 'command'
  command: string
  /** Seconds. */
  timeout?: number
}

export type HookMatcher = {
  /** Tool name, `A|B`, a regex, or `*` / empty for everything. */
  matcher?: string
  hooks: HookCommand[]
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

type HookInputBase = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
}

export type HookInput = HookInputBase &
  (
    | {
        hook_event_name: 'PreToolUse'
        tool_name: string
        tool_input: unknown
        tool_use_id: string
      }
    | {
        hook_event_name: 'PostToolUse'
        tool_name: string
        tool_input: unknown
        tool_response: unknown
        tool_use_id: string
      }
    | { hook_event_name: 'UserPromptSubmit'; prompt: string }
    | { hook_event_name: 'Stop'; stop_hook_active: boolean }
  )

/** The part of Claude Code's hook JSON output that these four events use. */
export const hookJSONOutputSchema = z
  .object({
    continue: z.boolean().optional(),
    stopReason: z.string().optional(),
    suppressOutput: z.boolean().optional(),
    systemMessage: z.string().optional(),
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().optional(),
    hookSpecificOutput: z
      .object({
        hookEventName: z.string(),
        permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
        permissionDecisionReason: z.string().optional(),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
        additionalContext: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type HookJSONOutput = z.infer<typeof hookJSONOutputSchema>

export type HookBlockingError = {
  blockingError: string
  command: string
}

/** Everything the matching hooks of one event said, taken together. */
export type AggregatedHookResult = {
  /** `PreToolUse:Bash`, `Stop`, ... */
  hookName: string
  blockingErrors: HookBlockingError[]
  additionalContexts: string[]
  /** Plain stdout of hooks that exited 0 (context for UserPromptSubmit). */
  outputs: string[]
  /** A hook answered `continue: false`. */
  preventContinuation: boolean
  stopReason?: string
  /** Warnings addressed to the user. */
  systemMessages: string[]
  /** PreToolUse only. Deny beats ask beats allow. */
  permissionBehavior?: 'allow' | 'deny' | 'ask'
  permissionReason?: string
  /** PreToolUse only. */
  updatedInput?: Record<string, unknown>
}
