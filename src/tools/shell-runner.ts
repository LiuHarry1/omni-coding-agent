import { tool } from 'ai'
import { z } from 'zod'
import { truncate } from './utils.js'
import type {
  DualChannelToolResult,
  ToolDefinition,
  ToolContext,
} from '../core/types.js'
import { isShellInputConcurrencySafe } from '../core/shell/shell-readonly.js'
import { runShellCommand, type ShellKind } from '../core/shell/spawn-shell.js'
import { spawnShellTask } from '../tasks/LocalShellTask/LocalShellTask.js'
import {
  getTaskOutputPath,
  setTaskSessionId,
} from '../utils/task/diskOutput.js'
import { isWorkerChannelLostError } from '../execution/worker-channel-error.js'

/**
 * Shared execution for Bash / PowerShell.
 * Background returns a task_id from spawnShellTask (not the OS pid).
 */

/**
 * Discrete execution outcome — the single source of truth the UI reads.
 * `interrupted` stays for the model-facing `is_error` mapping and old sessions.
 */
export type ShellOutcome =
  'success' | 'failure' | 'timeout' | 'aborted' | 'spawnError' | 'unknown'

export type ShellToolOutput = {
  text: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
  backgroundTaskId?: string
  backgrounded?: boolean
  interrupted?: boolean
  outcome?: ShellOutcome
  failureReason?: 'worker_lost'
}

export const ShellToolOutputSchema = z.object({
  text: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  backgroundTaskId: z.string().optional(),
  backgrounded: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  outcome: z
    .enum(['success', 'failure', 'timeout', 'aborted', 'spawnError'])
    .or(z.literal('unknown'))
    .optional(),
  failureReason: z.literal('worker_lost').optional(),
})

function outcomeOf(r: {
  code: number | null
  timedOut?: boolean
  interrupted?: boolean
}): ShellOutcome {
  if (r.timedOut) return 'timeout'
  if (r.interrupted) return 'aborted'
  return r.code === 0 ? 'success' : 'failure'
}

function shellOk(
  data: ShellToolOutput,
): DualChannelToolResult<ShellToolOutput> {
  return { data }
}

function unknownWorkerOutcome(): DualChannelToolResult<ShellToolOutput> {
  return shellOk({
    text:
      'Outcome unknown: the Worker channel was lost before the command was ' +
      'acknowledged. Inspect its effects before retrying.',
    interrupted: true,
    outcome: 'unknown',
    failureReason: 'worker_lost',
  })
}

const PROGRESS_INTERVAL_MS = 2_000

export interface ShellToolOptions {
  name: string
  description: string
  commandFieldDesc: string
  shell: ShellKind
}

export function createShellTool(opts: ShellToolOptions): ToolDefinition {
  const { name, description, commandFieldDesc, shell } = opts
  const briefDescription = description.split(/\.\s/)[0] + '.'

  return {
    name,
    description: briefDescription,
    isConcurrencySafe: isShellInputConcurrencySafe,
    interruptBehavior: () => 'block' as const,
    // Mode C — model may get wrappers in `text`; UI uses stdout/stderr
    outputSchema: ShellToolOutputSchema,
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const o = output as ShellToolOutput
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: o.text,
        ...(o.interrupted ? { is_error: true } : {}),
      }
    },
    create(cwd: string, context: ToolContext) {
      const wire = context?.wire
      const cwdRef = { current: cwd }

      return tool({
        description,
        inputSchema: z.object({
          command: z.string().describe(commandFieldDesc),
          description: z
            .string()
            .optional()
            .describe(
              'Very short phrase naming what this command does, shown to the user after the word "Ran" (e.g. "project file listing"). Avoid leading with verbs or using trailing periods.',
            ),
          timeout: z
            .number()
            .optional()
            .describe(
              'Max time in ms before killing. Default 120000 (2 min). Ignored when run_in_background is true.',
            ),
          run_in_background: z
            .boolean()
            .optional()
            .describe(
              'Set to true to run this command in the background. Use Read to read the output later.',
            ),
          stdin: z.string().optional().describe('Text to feed to stdin.'),
        }),
        execute: async (
          args: {
            command: string
            description?: string
            timeout?: number
            run_in_background?: boolean
            stdin?: string
          },
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ): Promise<DualChannelToolResult<ShellToolOutput> | string> => {
          const toolUseId = options?.toolCallId ?? ''
          const abortSignal = options?.abortSignal
          if (abortSignal?.aborted) {
            return shellOk({
              text: truncate('[interrupted by user]'),
              interrupted: true,
              outcome: 'aborted',
            })
          }
          const {
            command,
            run_in_background = false,
            stdin,
            timeout = 120_000,
            description: cmdDesc,
          } = args

          if (!command?.trim()) {
            return 'Error: provide `command` to run.'
          }

          const sessionId = context.sessionId ?? 'default'
          setTaskSessionId(sessionId)

          // ── Background (run_in_background → spawnShellTask) ──
          if (run_in_background) {
            if (stdin != null && stdin.length > 0) {
              return 'Error: stdin piping is not supported with run_in_background.'
            }
            try {
              const handle = await spawnShellTask(
                {
                  command,
                  description: cmdDesc ?? command,
                  toolUseId: toolUseId || undefined,
                  sessionId,
                  shell,
                  cwd: cwdRef.current,
                },
                { execution: context.execution },
              )
              const outPath = getTaskOutputPath(handle.taskId)
              const text = `Command running in background with ID: ${handle.taskId}. Output is being written to: ${outPath}`
              return shellOk({
                text,
                backgroundTaskId: handle.taskId,
                backgrounded: true,
                exitCode: 0,
                outcome: 'success',
              })
            } catch (err) {
              if (isWorkerChannelLostError(err)) {
                return unknownWorkerOutcome()
              }
              const msg = err instanceof Error ? err.message : String(err)
              return shellOk({
                text: truncate(`[error starting background task: ${msg}]`),
                interrupted: true,
                outcome: 'spawnError',
              })
            }
          }

          // ── Foreground via Worker ──
          const execution = context.execution
          if (execution) {
            if (stdin != null && stdin.length > 0) {
              return 'Error: stdin piping is not supported over Worker execution yet.'
            }
            try {
              const result = await execution.exec(command, {
                cwd: cwdRef.current,
                timeoutMs: timeout,
                shell,
                signal: abortSignal,
              })
              if (result.cwdAfter) cwdRef.current = result.cwdAfter
              let out = result.stdout || ''
              if (result.stderr) {
                out += (out ? '\n' : '') + `<stderr>\n${result.stderr}</stderr>`
              }
              if (result.code !== 0 && result.code !== null) {
                out += `\n[exit code: ${result.code}]`
              }
              const interrupted = !!(result.timedOut || result.interrupted)
              if (interrupted) {
                out += result.timedOut
                  ? `\n[timed out after ${(timeout / 1000).toFixed(1)}s]`
                  : '\n[interrupted]'
              }
              const final =
                out ||
                (result.code === 0
                  ? '(no output)'
                  : `(no output, exit code ${result.code})`)
              const text = truncate(final)
              if (wire && toolUseId) {
                wire.processOutput(toolUseId, name, text)
              }
              return shellOk({
                text,
                stdout: result.stdout || '',
                stderr: result.stderr || '',
                exitCode: result.code,
                interrupted,
                outcome: outcomeOf(result),
              })
            } catch (err) {
              if (isWorkerChannelLostError(err)) {
                return unknownWorkerOutcome()
              }
              const msg = err instanceof Error ? err.message : String(err)
              return shellOk({
                text: truncate(`[error: ${msg}]`),
                stdout: '',
                stderr: msg,
                exitCode: 1,
                interrupted: true,
                outcome: 'spawnError',
              })
            }
          }

          // Remote sessions must never run shell on the Control Plane host
          // (Windows path.resolve turns /home/... into C:\home\... → /c/home/...).
          const envId =
            context.session?.workspace?.environmentId ??
            context.execution?.environmentId
          if (envId && envId !== 'local') {
            return shellOk({
              text: truncate(
                `[error: no Worker execution backend for remote environment ${envId}; refusing local shell fallback]`,
              ),
              stdout: '',
              stderr: `Remote shell requires Worker execution (env=${envId})`,
              exitCode: 1,
              interrupted: true,
              outcome: 'spawnError',
            })
          }

          // ── In-process foreground (tests / no Worker) — file-fd like Worker ──
          try {
            const start = Date.now()
            const result = await runShellCommand({
              shell,
              command,
              cwd: cwdRef.current,
              timeoutMs: timeout,
              stdin,
              abortSignal,
              cwdFilePrefix: 'agent-shell-cwd',
              progressIntervalMs: PROGRESS_INTERVAL_MS,
              onProgress:
                wire && toolUseId
                  ? text => {
                      wire.processOutput(toolUseId, name, truncate(text))
                    }
                  : undefined,
            })
            if (result.cwdAfter) cwdRef.current = result.cwdAfter

            let out = result.stdout || ''
            if (result.stderr) {
              out += (out ? '\n' : '') + `<stderr>\n${result.stderr}</stderr>`
            }
            if (result.code !== 0 && result.code !== null) {
              out += `\n[exit code: ${result.code}]`
            }
            const interrupted = !!(result.interrupted || result.timedOut)
            if (interrupted) {
              out += `\n[interrupted after ${((Date.now() - start) / 1000).toFixed(1)}s]`
            }
            const final =
              out ||
              (result.code === 0
                ? '(no output)'
                : `(no output, exit code ${result.code})`)
            const text = truncate(final)
            if (wire && toolUseId) {
              wire.processOutput(toolUseId, name, text)
            }
            return shellOk({
              text,
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              exitCode: result.code,
              interrupted,
              outcome: outcomeOf(result),
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return shellOk({
              text: truncate(`[error: ${msg}]`),
              interrupted: true,
              outcome: 'spawnError',
            })
          }
        },
      })
    },
  }
}
