/**
 * Task type registry.
 */
import type { Task, TaskType } from './Task.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'

export function getAllTasks(): Task[] {
  return [LocalShellTask, LocalAgentTask]
}

export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
