# Background Tasks

Background tasks let the agent start long-running work, carry on, and be
told when it is over. There are two kinds: a shell command and a subagent.
Both are tasks in the same per-session list, read with `TaskOutput`, stopped
with `TaskStop`, and both report back with a `<task-notification>`.

## Shell commands

1. A shell tool starts a command with `run_in_background`.
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

The command usually outlives the turn that started it. The turn releases its
execution backend when it ends, so the task is watched through a backend of
its own on the same worker.

## Subagents

The Agent tool takes `run_in_background: true`. It follows Claude Code's
`LocalAgentTask`.

1. The tool registers a `local_agent` task (ids start with `a`) and returns
   at once with "Async agent launched successfully", the agent id and the
   path of its output file. The model is told not to wait, poll, or repeat
   the agent's work.
2. The agent runs on after the turn has ended. It therefore gets what the
   turn would otherwise have lent it: its own abort controller (stopping the
   turn does not stop the agent), its own event bus, and its own execution
   backend, released when the agent is done.
3. Nobody can answer a prompt from a background agent. A shell command no
   rule mentions runs; a command under an ask rule, and a file outside the
   workspace, are refused.
4. While it works, the output file gets what the agent says and one line per
   tool call. The task records the number of tool calls, the tokens used and
   the last activity.
5. When it ends, the notification carries its final report in `<result>` and
   the cost in `<usage>` (tokens, tool calls, duration). An agent that was
   stopped reports what it had written so far; one that failed reports the
   error.

`TaskOutput` on an agent returns the final report once there is one, and the
output file while it is still working.

Use a foreground agent (the default) when the main agent needs the result
before it can go on, and a background agent for work that is independent of
what the main agent does next.

A background agent's nested steps are not streamed to the client. The web
client lists it in the background task panel with its current activity and a
Stop button, and the Agent tool row reads "Started in the background".

## Interfaces

- Agent tools: `Agent` (`run_in_background`), `TaskOutput`, `TaskStop`
- HTTP: `GET /sessions/:id/tasks` — agents also carry `agentType`,
  `activity` and `toolUses`
- HTTP: `POST /sessions/:id/tasks/:taskId/stop`

## Failure modes

- Tasks are tied to the execution backend. Remote tasks must be polled and
  stopped through the same remote worker.
- A process may exit before its final output is consumed; the disk-backed log
  remains the source for the final read.
- Stopping a task is best-effort across process trees and platforms.
- Tasks live in the server process. A restart ends a background agent
  without a notification.
- Where the Agent tool has no session to report back to, the agent runs in
  the foreground instead.
- In a remote workspace the agent's output file is on the server, not on the
  worker, so the model is not pointed at it; `TaskOutput` still works.
- A background agent's model usage is counted against the session owner's
  quota when the agent ends, not while it runs.
- A message cannot be sent to a running background agent, and a finished one
  cannot be resumed.

## Source map

- `src/tasks/LocalShellTask/`
- `src/tasks/LocalAgentTask/LocalAgentTask.ts` — agent task state and
  notification.
- `src/tools/AgentTool/runAsyncAgent.ts` — the agent's life after launch.
- `src/tools/AgentTool/AgentTool.ts` — the `run_in_background` branch.
- `src/server/background-usage.ts` — telemetry and quota after the turn.
- `src/utils/task/`
- `src/tasks/stopTask.ts`
- `src/utils/messageQueueManager.ts`, `src/services/queue/queue-processor.ts`

**Last verified:** 2026-11-14
