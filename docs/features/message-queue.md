# Message queue

Last verified: 2026-11-14

## Overview

One queue per session holds everything that wants the agent's attention
while it may be busy: messages the user sends during a turn, and
notifications from [background tasks](background-tasks.md) (shell commands
and subagents). It follows Claude Code's
`messageQueueManager`.

Without it, a message sent during a turn was refused, and a background task
that finished while the session was idle went unnoticed until the user wrote
again.

## How it works

Each queued command has a mode (`prompt` or `task-notification`) and a
priority. `now` comes before `next`, `next` before `later`; within one
priority the order is first in, first out. User messages default to `next`,
task notifications to `later`, so system messages never starve user input.

The queue is drained in two places.

**Between tool rounds.** After the tools of a step have run and before the
next model request, the query loop takes the commands with priority `next`
or higher. Each is added to the conversation as a `queued_command`
attachment, which the model reads as a system reminder:

- a user message: "The user sent a new message while you were working: …
  After completing your current task, you MUST address the user's message
  above."
- a task notification: "A background agent completed a task: …"

The client is told with a `queued_command` event. Slash commands are never
taken mid-turn; they need a turn of their own. A subagent's loop takes only
commands addressed to its agent id, the main agent only those addressed to
nobody.

**Between turns.** When a turn ends, or something is queued while no turn is
running, the queue processor looks at what is left:

- Task notifications start a turn of their own. All that are waiting go into
  one turn, whose prompt is the notifications themselves. The turn is
  streamed over `GET /sessions/:id/live`, opened by a `queued_turn` event,
  the same way a scheduled task is. It starts half a second after the
  trigger so that notifications arriving together are answered together.
- User messages are dropped. The client that queued them still has them and
  sends them as an ordinary chat request (see below).

A task notification therefore does not interrupt a running turn; it is
answered once the turn is over.

The queue processor runs in the HTTP server. The stdio CLI and ACP have no
live stream to carry a turn nobody asked for, so there task notifications
are handed over inside the user's turns instead: with the opening message of
the next turn, and after every tool round.

## Sending a message during a turn

```
POST   /sessions/:id/queue        { "message": "...", "id": "optional-id" }
GET    /sessions/:id/queue
DELETE /sessions/:id/queue/:id
```

`POST` answers `202 { queued: true, id }` while a turn is running and
`409 { queued: false }` when none is; in that case send the message with
`POST /chat`. A session holds at most 20 queued messages.

A queued message has one of two fates:

1. The running turn reaches another tool round. The message is handed to
   the model and the stream carries
   `{ type: "system", subtype: "queued_command", command_mode: "prompt", prompt, command_uuid }`
   where `command_uuid` is the id it was queued under.
2. The turn ends first. The server drops the message. The client has seen no
   `queued_command` event for it by the time the turn's `result` arrives,
   and sends it as a new turn.

The web client does this for you: while the agent is working, Enter queues
the message and shows it above the composer, where it can still be removed.
Once picked up, it moves into the transcript at the point where the model
received it. Messages the turn did not get to are sent together when it
ends. Stopping the turn puts them back into the composer instead of sending
them. Attachments cannot be queued.

## Failure modes

- A turn started for task notifications is unattended, like a scheduled
  turn: tool calls that would need the user's approval are refused.
- If the session owner's quota is used up, the notifications stay queued and
  are tried again after the next turn in that session.
- If the session's cloud workspace is not available, the notifications are
  dropped with a warning in the server log.
- The queue lives in the server process. A restart loses queued commands;
  background tasks do not survive a restart either.
- A client that is not connected to the live stream does not see a
  notification turn as it runs. The turn is stored and appears on reload.
- If the client sends its unconsumed messages at the same moment the server
  starts a notification turn, the chat request can be refused with 409
  ("still being processed"). The half-second delay makes this unlikely.

## Source map

- `src/utils/messageQueueManager.ts` — the queue.
- `src/core/query.ts` — hand-over between tool rounds.
- `src/utils/attachments/queued-commands.ts` — attachment and model wording.
- `src/services/queue/queue-processor.ts` — between-turn processing.
- `src/server/routes/session-queue.ts` — HTTP routes.
- `web/src/stores/chat/queued-messages.js` — client-side queue.
