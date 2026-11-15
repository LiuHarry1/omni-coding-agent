# Scheduled tasks

Last verified: 2026-09-13

## Overview

Scheduled tasks store a prompt for later execution in a specific session. A task is either a one-shot absolute time or a five-field cron expression evaluated in local time. The process-wide store holds at most 50 tasks.

## How it works

The in-process scheduler reads `scheduled_tasks.json`, arms a timer no longer than 60 seconds, and fires due tasks. Tasks in the same session run serially; different sessions may run concurrently. A run reopens the owning session, acquires its turn lock, emits a scheduled-turn event, and executes a normal meta chat turn in the session workspace.

One-shot tasks are removed after firing. Recurring tasks receive deterministic jitter of up to 10% of their interval, capped at 15 minutes, and expire seven days after creation. A missing session removes its tasks; a busy session leaves the task due for a later tick. Quota-exceeded tasks are delayed by 60 seconds.

## Configuration and API

The feature defaults to enabled. Disable it per resolved workspace:

```json
{
  "scheduledTasks": {
    "enabled": false
  }
}
```

HTTP endpoints:

- `GET /scheduled-tasks?session_id=<id>&workspace=<path>` returns `enabled`, the session ID, and that session's tasks.
- `POST /scheduled-tasks` accepts `session_id?`, `workspace?`, `environmentId?`, `agentType?`, `mode?`, `prompt`, and exactly one of `cron` or `at`; `recurring` defaults to true for cron and is always false for `at`.
- `DELETE /scheduled-tasks/:id?session_id=<id>` deletes only a task owned by that session.

Cron syntax is `M H DoM Mon DoW`. Absolute `at` values must parse to a future time.

## Failure modes and security notes

- Disabled scheduling returns HTTP 403; invalid JSON, empty prompts, invalid schedules, and past times return HTTP 400.
- Session access is checked before list, create-on-existing-session, and delete operations; inaccessible sessions appear as 404.
- A corrupt JSON store raises an explicit corruption error rather than silently discarding all tasks.
- Persistence is process-scoped, so multi-replica deployments need external coordination to avoid independent schedulers sharing or duplicating work.
- The scheduler checks quota before a run, but a quota service outage is fail-open and only logs a warning.

## Source map

- `src/services/cron/types.ts` — limits and task/result types.
- `src/services/cron/store.ts` — JSON persistence, IDs, expiry, and jitter.
- `src/services/cron/scheduler.ts` — timer and per-session serialization.
- `src/services/cron/fire.ts` — session execution, quota, and cleanup.
- `src/services/cron/schedule.ts` — validation and public task shape.
- `src/server/routes/scheduled-tasks.ts` — HTTP API and access checks.
- `src/utils/settings/schema.ts` — `scheduledTasks.enabled`.
