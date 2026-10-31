/**
 * Task IDs and base state.
 */
import { randomBytes } from 'crypto'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

export type TaskType = 'local_bash'

export type TaskStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'unknown'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'unknown'
  )
}

export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  sessionId?: string
  shell?: 'bash' | 'powershell'
  cwd: string
}

/**
 * Polymorphic task impl (kill only; spawn is typed per-impl).
 * Local: sessionId + optional ExecutionBackend instead of setAppState.
 */
export type Task = {
  name: string
  type: TaskType
  kill(
    taskId: string,
    sessionId: string,
    execution?: import('./execution/execution-backend.js').ExecutionBackend,
  ): void | Promise<void>
}

const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b',
}

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] ?? 'x'
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
