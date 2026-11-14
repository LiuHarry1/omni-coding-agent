# Background Tasks

Background tasks let the agent start a long-running shell command, continue
reasoning, inspect output later, and stop the process when it is no longer
needed.

## Lifecycle

1. A shell tool starts a command in the background.
2. `LocalShellTask` owns the process and streams output to a disk-backed log.
3. `TaskOutput` returns new output and task status without replaying the entire
   log into the model context.
4. `TaskStop` or the session task API terminates the task.
5. When the task ends, a `<task-notification>` goes into the session's
   [message queue](message-queue.md). It does not interrupt a running turn:
   once the session is idle, the queued notifications start a turn of their
   own, so the agent reacts to a finished task without the user writing first.

This design keeps long output out of the active context and prevents a blocked
command from blocking the agent loop.

## Interfaces

- Agent tools: `TaskOutput`, `TaskStop`
- HTTP: `GET /sessions/:id/tasks`
- HTTP: `POST /sessions/:id/tasks/:taskId/stop`

## Failure modes

- Tasks are tied to the execution backend. Remote tasks must be polled and
  stopped through the same remote worker.
- A process may exit before its final output is consumed; the disk-backed log
  remains the source for the final read.
- Stopping a task is best-effort across process trees and platforms.

## Source map

- `src/tasks/LocalShellTask/`
- `src/utils/task/`
- `src/tasks/stopTask.ts`
- `src/utils/messageQueueManager.ts`, `src/services/queue/queue-processor.ts`

**Last verified:** 2026-11-14
