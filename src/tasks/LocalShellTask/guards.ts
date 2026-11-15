/**
 * LocalShellTask state + type guards.
 */
import type { TaskStateBase } from '../../Task.js'
import type { ShellKind } from '../../utils/shell/spawn-shell.js'

export type BashTaskKind = 'bash'

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash'
  command: string
  result?: {
    code: number | null
    interrupted: boolean
    reason?: 'worker_lost'
  }
  completionStatusSentInAttachment: boolean
  /** Worker / local pid when known. */
  pid?: number
  shell: ShellKind
  sessionId: string
  cwd: string
  isBackgrounded: boolean
  kind?: BashTaskKind
  /**
   * The subagent that started it. Its notification is addressed to that
   * agent, and it is stopped when the agent exits. Unset: main thread.
   */
  agentId?: string
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    (task as { type: string }).type === 'local_bash'
  )
}
