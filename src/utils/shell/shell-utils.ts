import { isWindows } from '../platform.js'
import {
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
} from '../../constants/tool_names.js'
import type { ShellKind } from './spawn-shell.js'
import { findGitBashPath } from './windows-paths.js'

/**
 * Claude-style shell availability:
 * - Unix: Bash only.
 * - Windows with Git for Windows: Bash and PowerShell.
 * - Windows without Git for Windows: PowerShell only.
 */
export function resolveShellCapabilities(
  windows: boolean,
  gitBashAvailable: boolean,
): {
  bash: boolean
  powershell: boolean
  defaultKind: ShellKind
  defaultToolName: string
} {
  const bash = !windows || gitBashAvailable
  const powershell = windows
  return {
    bash,
    powershell,
    defaultKind: bash ? 'bash' : 'powershell',
    defaultToolName: bash ? BASH_TOOL_NAME : POWERSHELL_TOOL_NAME,
  }
}

function currentShellCapabilities() {
  return resolveShellCapabilities(
    isWindows,
    isWindows && findGitBashPath() !== null,
  )
}

export function isBashToolEnabled(): boolean {
  return currentShellCapabilities().bash
}

export function isPowerShellToolEnabled(): boolean {
  return currentShellCapabilities().powershell
}

/** Prefer Bash when available; otherwise fall back to native PowerShell. */
export function getDefaultShellToolName(): string {
  return currentShellCapabilities().defaultToolName
}

export function getDefaultShellKind(): ShellKind {
  return currentShellCapabilities().defaultKind
}

export function getAvailableShellToolNames(): string[] {
  return [
    ...(isBashToolEnabled() ? [BASH_TOOL_NAME] : []),
    ...(isPowerShellToolEnabled() ? [POWERSHELL_TOOL_NAME] : []),
  ]
}
