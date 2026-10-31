# Durable Cloud Runs

## Session and Run

A Session is the durable, multi-turn conversation. A Run is one accepted user
request inside that Session, from creation to a terminal status. A Session has
at most one active Run.

HTTP clients receive a stable Run ID from `POST /chat` in `X-Run-Id`. The
initial SSE response is only the first subscription:

- closing, refreshing, or losing that HTTP connection detaches the subscriber;
- `GET /runs/:runId` reads status independently of a stream;
- `GET /runs/:runId/stream?after_seq=N` replays events after `N` and then
  follows live events;
- `Last-Event-ID` is accepted as the equivalent resume cursor;
- `POST /runs/:runId/cancel` is the operation that stops a Run.

`POST /chat/cancel` remains a Session-oriented compatibility endpoint and
cancels that Session's active Run.

## Persistence

The Session JSONL transcript remains the canonical model history. Each Run has
an operational sidecar under:

```text
{session-data}/runs/{runId}/
  state.json
  events.jsonl
```

`state.json` is replaced atomically. `events.jsonl` is append-only. Every event
is persisted before fan-out and has a monotonically increasing `seq`; delivery
is at least once, so clients deduplicate by sequence.

Each wire scope (`parent_tool_use_id`, or the root Run) persists only its first
terminal `result`. This preserves independent subagent results without allowing
a later duplicate success to overwrite an earlier failure.

Transcript checkpoints are awaited at two boundaries:

1. after attachments and the opening user message enter history, before the
   first model request;
2. after every complete model/tool step, including tool results and post-step
   attachments.

Full compaction and normal step persistence share one transcript cursor. This
prevents the same message from being appended twice. `checkpointSeq` means
events through that sequence are represented by the durable transcript, so a
refresh loads the transcript snapshot and resumes events after that cursor.

## Process recovery

Startup scans non-terminal Run sidecars across tenant homes. A recoverable Run
keeps its Run ID, increments `attempt`, enters `recovering`, and continues from
the persisted transcript with a meta continuation. If the process stopped
before the opening message checkpoint, the accepted request payload in the Run
sidecar seeds the original turn instead.

Recovery is semantic, not a restoration of process memory. The old model
stream, in-memory caches, and live tool processes are gone. Recovery attempts
are bounded; a missing Session or exhausted attempt budget makes the Run
terminal with an error.

Cancellation first persists `cancelRequestedAt` while the Run remains
`running`. The Worker cancels the foreground RPC by its request ID and the Run
becomes `cancelled` only after that RPC settles. If the Worker does not confirm
within five seconds, its runtime is closed. POSIX shell process groups (and
Windows process trees) are terminated together so child commands do not become
orphans. A persisted cancellation marker is terminalized, never resumed, after
a control-plane restart.

The per-home Run index stores the active Run ID for each Session. Startup
repairs old or stale pointers once; normal request paths read a single state
sidecar. Loading `lastSeq` scans backward from the tail of `events.jsonl` and
expands only when the last complete event is larger than the current window,
while ignoring a torn final row.

## Side-effect safety

The system does not claim exactly-once execution for file writes, shell
commands, MCP calls, or other side effects. If an assistant tool call has no
acknowledged result after restart, replay inserts an explicit error result with:

```json
{ "status": "unknown", "reason": "worker_lost" }
```

The continuation is instructed to inspect files, Git state, task output, or the
external system before deciding whether to retry. A live Worker channel loss
also rejects all pending RPCs immediately. Background commands become
`unknown/worker_lost`; `exitCode: null` is never treated as success.

Persisted `tool_call` and `tool_result` Run events also act as a write-ahead
ledger for a process crash between tool execution and the complete-step
transcript checkpoint. Recovery reconstructs acknowledged results and marks
unacknowledged calls `unknown` before continuing.

The durable guarantee is therefore: step-level checkpoints, at-least-once
events, and inspect-before-retry for unacknowledged side effects.

## Source map

- `src/services/runs/run-manager.ts` — lifecycle, mutual exclusion, cancellation
- `src/services/runs/run-store.ts` — state and event sidecars
- `src/services/runs/run-transport.ts` — persist-before-fan-out SSE
- `src/services/runs/recovery.ts` — startup scan and semantic continuation
- `src/turn/run-chat-turn.ts` — transcript checkpoint boundaries
- `web/src/stores/chat/stream-chat.js` — sequence-aware reconnect
- `sdks/typescript/src/client.ts` — Run status, stream, and cancel APIs
