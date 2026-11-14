import type { Message } from '../types.js'
import { createHookRunner, type HookRunner } from './hooks.js'
import { hookResultMessages } from './messages.js'
import type { HooksConfig } from './types.js'

function isAuthEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase(),
  )
}

let warnedSkipped = false

/**
 * The hooks of a chat turn, or undefined when there are none to run.
 *
 * Hook commands run on the machine the server runs on, in the workspace
 * directory. That is the wrong place for a remote workspace (its files live
 * elsewhere) and for a shared SSO server (one user's project settings would
 * run commands for everybody's host), so both go without hooks.
 */
export function createSessionHookRunner(args: {
  hooks: HooksConfig | undefined
  remote: boolean
  cwd: string
  sessionId: string
  transcriptPath?: string
  getPermissionMode?: () => string | undefined
}): HookRunner | undefined {
  const { hooks } = args
  if (!hooks || Object.values(hooks).every(m => !m || m.length === 0)) {
    return undefined
  }
  if (args.remote || isAuthEnabled()) {
    if (!warnedSkipped) {
      warnedSkipped = true
      console.warn(
        `[hooks] hooks are configured but do not run ${args.remote ? 'for remote workspaces' : 'when AUTH_ENABLED is set'}`,
      )
    }
    return undefined
  }
  return createHookRunner({
    hooks,
    cwd: args.cwd,
    sessionId: args.sessionId,
    transcriptPath: args.transcriptPath,
    getPermissionMode: args.getPermissionMode,
  })
}

/**
 * Runs the UserPromptSubmit hooks on what the user typed. Returns what they
 * add to the context, to go right after the user message. Throws when a hook
 * refuses the prompt or stops the turn; the wording follows Claude Code.
 */
export async function submitUserPrompt(
  hooks: HookRunner,
  prompt: string,
  signal?: AbortSignal,
): Promise<Message[] | undefined> {
  if (!hooks.has('UserPromptSubmit')) return undefined
  const submitted = await hooks.userPromptSubmit(prompt, signal)
  const blocked = submitted.blockingErrors[0]
  if (blocked) {
    throw new Error(
      `UserPromptSubmit operation blocked by hook:\n${blocked.blockingError}`,
    )
  }
  if (submitted.preventContinuation) {
    throw new Error(
      submitted.stopReason
        ? `Operation stopped by hook: ${submitted.stopReason}`
        : 'Operation stopped by hook',
    )
  }
  const notes = hookResultMessages(submitted, { outputs: true })
  return notes.length > 0 ? notes : undefined
}
