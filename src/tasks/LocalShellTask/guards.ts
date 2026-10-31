/**
 * LocalShellTask state + type guards.
 */
import type { TaskStateBase } from '../../Task.js'
import type { ShellKind } from '../../core/shell/spawn-shell.js'

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
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    (task as { type: string }).type === 'local_bash'
  )
}
