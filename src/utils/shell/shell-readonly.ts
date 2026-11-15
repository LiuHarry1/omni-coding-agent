/**
 * Read-only check for shell tool inputs.
 *
 * The judgement itself is Claude Code's allowlist (see
 * `tools/BashTool/readOnlyValidation.ts`). Running in parallel asks for one
 * more thing: no `cd`, because shell tools share a per-instance cwd ref that
 * would race under concurrent `cd`.
 */
import { isBashCommandReadOnly } from '../../tools/BashTool/readOnlyValidation.js'
import { splitCommand } from '../bash/commands.js'

const CD_COMMAND = /^cd(?:\s|$)/

export function isShellCommandReadOnly(command: string): boolean {
  return isBashCommandReadOnly(command)
}

/** Input shape shared by bash / powershell tools. */
export function isShellInputConcurrencySafe(input: unknown): boolean {
  const args = input as {
    command?: string
    run_in_background?: boolean
    background?: boolean
  }

  if (args.run_in_background || args.background) return false
  if (!args.command) return false
  if (!isShellCommandReadOnly(args.command)) return false
  return !splitCommand(args.command).subcommands.some(sub =>
    CD_COMMAND.test(sub),
  )
}
