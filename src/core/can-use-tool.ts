/**
 * Tool permission gate.
 *
 * `createCanUseTool` runs `tool.checkPermissions`, then:
 *   - allow → execute
 *   - ask + dontAsk (SSO) → deny
 *   - ask + default (desktop) → control_request can_use_tool
 *
 * A shell command that needs approval follows the same route, except that
 * where nobody can answer (`dontAsk`, scheduled turns) the tool says what
 * happens instead: a command under an ask rule is refused, a command no rule
 * mentions runs.
 */
import { randomUUID } from 'crypto'
import {
  EDIT_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import type { Session, ToolDefinition } from './types.js'
import type { WireEmitter } from './wire-emitter.js'
import {
  addAlwaysAllowDirectory,
  denyOutsideMessage,
  filePathFromInput,
  policyFromContext,
  type CommandPermissionAsk,
  type FilesystemPermissionContext,
  type FsPermissionDecision,
} from '../utils/permissions/filesystem.js'
import {
  persistAlwaysAllowDirectory,
  persistAlwaysAllowRules,
} from './settings-manager.js'
import { resolvePath } from '../tools/utils.js'
import {
  registerPermission,
  type PermissionAnswer,
} from './brokers/permission-broker.js'

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

export type CanUseToolMeta = { toolUseId?: string }

export type CanUseToolFn = (
  toolName: string,
  input: unknown,
  meta?: CanUseToolMeta,
) => Promise<PermissionDecision> | PermissionDecision

/** Default gate — all tools allowed. */
export const allowAllTools: CanUseToolFn = async () => ({ behavior: 'allow' })

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

const WRITE_TOOLS = new Set([WRITE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME])

export type CreateCanUseToolOptions = {
  cwd: string
  getDefinition?: (name: string) => ToolDefinition | undefined
  permissionContext?: FilesystemPermissionContext
  session?: Session
  wire: WireEmitter
  abortSignal?: AbortSignal
  /** False when no person is attached to the turn (scheduled tasks). Default true. */
  interactive?: boolean
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

function grantPath(
  cwd: string,
  def: ToolDefinition | undefined,
  input: unknown,
  decision: Extract<FsPermissionDecision, { behavior: 'ask' }>,
): string {
  const raw = def?.getPath?.(input) ?? filePathFromInput(input) ?? decision.path
  const resolved = resolvePath(cwd, raw)
  if ('error' in resolved) return decision.path
  return resolved.abs
}

function applyAlwaysAllow(
  absPath: string,
  permissionContext: FilesystemPermissionContext,
  session: Session | undefined,
  cwd: string,
): void {
  const dir = addAlwaysAllowDirectory(permissionContext, absPath)
  if (session) {
    if (!session.additionalWorkingDirectories) {
      session.additionalWorkingDirectories = []
    }
    if (!session.additionalWorkingDirectories.includes(dir)) {
      session.additionalWorkingDirectories.push(dir)
    }
  }
  if (permissionContext.mode === 'dontAsk') return
  try {
    persistAlwaysAllowDirectory(cwd, dir)
  } catch (err) {
    console.warn(
      `[permissions] failed to persist Always allow ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

function applyAlwaysAllowRules(
  rules: string[],
  permissionContext: FilesystemPermissionContext,
  cwd: string,
): void {
  for (const rule of rules) {
    if (!permissionContext.allow.includes(rule)) {
      permissionContext.allow.push(rule)
    }
  }
  try {
    persistAlwaysAllowRules(cwd, rules)
  } catch (err) {
    console.warn(
      `[permissions] failed to persist Always allow ${rules.join(', ')}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

function isCommandAsk(
  decision:
    Extract<FsPermissionDecision, { behavior: 'ask' }> | CommandPermissionAsk,
): decision is CommandPermissionAsk {
  return 'command' in decision
}

/**
 * Permission pipeline: checkPermissions → dontAsk maps ask to deny
 * → default mode prompts Allow / Always / Reject.
 */
export function createCanUseTool(opts: CreateCanUseToolOptions): CanUseToolFn {
  const { cwd, getDefinition, session, wire, abortSignal } = opts
  const permissionContext = opts.permissionContext ?? policyFromContext(cwd)
  const interactive = opts.interactive ?? true

  return async (toolName, input, meta) => {
    const def = getDefinition?.(toolName)
    if (!def?.checkPermissions) return { behavior: 'allow' }

    const decision = await def.checkPermissions(input, {
      cwd,
      permissionContext,
    })
    if (decision.behavior === 'allow') return { behavior: 'allow' }
    if (decision.behavior === 'deny') {
      return { behavior: 'deny', message: decision.message }
    }

    const commandAsk = isCommandAsk(decision) ? decision : undefined
    const pathAsk = isCommandAsk(decision) ? undefined : decision

    if (commandAsk && (permissionContext.mode === 'dontAsk' || !interactive)) {
      if (commandAsk.whenUnattended === 'allow') return { behavior: 'allow' }
      return {
        behavior: 'deny',
        message: `${toolName} needs approval to run ${commandAsk.command}, and nobody can be asked in this session.`,
      }
    }
    if (pathAsk && permissionContext.mode === 'dontAsk') {
      return {
        behavior: 'deny',
        message: denyOutsideMessage(
          pathAsk.path,
          permissionContext.root,
          WRITE_TOOLS.has(toolName) ? 'write' : 'read',
        ),
      }
    }

    const requestId = meta?.toolUseId ?? randomUUID()
    wire.canUseTool({
      request_id: requestId,
      tool_name: toolName,
      tool_use_id: meta?.toolUseId ?? requestId,
      input: inputRecord(input),
      title: toolName,
      description: decision.message,
      ...(commandAsk
        ? { command: commandAsk.command, always_rules: commandAsk.rules }
        : {}),
    })

    const result = await registerPermission(
      requestId,
      PERMISSION_TIMEOUT_MS,
      abortSignal,
    )

    if (!result.answered) {
      return {
        behavior: 'deny',
        message:
          result.reason === 'timeout'
            ? `Permission request timed out for ${toolName}.`
            : `Permission request was cancelled for ${toolName}.`,
      }
    }

    const answer: PermissionAnswer = result.value
    if (answer.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: commandAsk
          ? `User rejected ${toolName} command ${commandAsk.command}.`
          : `User rejected ${toolName} on ${pathAsk?.path}.`,
      }
    }

    if (answer.behavior === 'always') {
      if (commandAsk) {
        applyAlwaysAllowRules(commandAsk.rules, permissionContext, cwd)
      } else if (pathAsk) {
        applyAlwaysAllow(
          grantPath(cwd, def, input, pathAsk),
          permissionContext,
          session,
          cwd,
        )
      }
    }

    return { behavior: 'allow' }
  }
}
