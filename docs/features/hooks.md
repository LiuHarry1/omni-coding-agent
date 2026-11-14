# Hooks

Last verified: 2026-11-14

## Overview

Hooks are shell commands of your own that run at fixed points of a turn: before and after each tool call, when a prompt is submitted, and when the model is about to end the turn. A hook can observe, add context for the model, refuse a tool call, or send the model back to work.

The settings format, the JSON a hook receives and the answers it can give follow Claude Code, so a hook script written for Claude Code works here for the four events below.

## How it works

| Event              | When it runs                                                | What blocking does                                                       |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PreToolUse`       | After a tool call is validated, before the permission check | The tool does not run; the reason is returned to the model as its result |
| `PostToolUse`      | After a tool finished without an error                      | The tool result stands; the reason is added for the model to act on      |
| `UserPromptSubmit` | Before a prompt you typed reaches the model                 | The prompt is dropped and the reason is shown to you                     |
| `Stop`             | When the model replies without calling a tool               | The reason is sent to the model and the turn continues                   |

`PreToolUse` and `PostToolUse` take a `matcher` that selects tools by name: a name (`Bash`), alternatives (`Edit|Write`), a regular expression (`mcp__github__.*`), or `*` / nothing for every tool. Hooks that match the same event run in parallel, and a command listed more than once runs once.

Each command receives one JSON object on stdin:

```json
{
  "session_id": "…",
  "transcript_path": "/…/session.jsonl",
  "cwd": "/path/to/workspace",
  "permission_mode": "agent",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "tool_use_id": "…"
}
```

`PostToolUse` adds `tool_response`, `UserPromptSubmit` carries `prompt`, and `Stop` carries `stop_hook_active`, which is `true` while the model is answering an earlier Stop hook's feedback. A Stop hook that always blocks keeps the turn going forever; check this flag and let the turn end when it is set.

The command runs in the workspace directory with `CLAUDE_PROJECT_DIR` and `AGENT_PROJECT_DIR` set to it.

### Answering with an exit code

- `0` — success. For `UserPromptSubmit`, anything printed to stdout is added to the model's context.
- `2` — block. stderr is the reason.
- Anything else — a warning in the server log; the turn carries on.

### Answering with JSON

A command that exits `0` and prints a JSON object can say more:

```json
{
  "continue": false,
  "stopReason": "Shown to the user when continue is false",
  "decision": "block",
  "reason": "Why it was blocked",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Shown in the prompt or to the model",
    "updatedInput": { "command": "npm test -- --run" },
    "additionalContext": "Text added for the model"
  }
}
```

- `continue: false` ends the turn after the current step, on any event.
- `decision: "block"` with `reason` is the same as exit code 2.
- `permissionDecision` (`PreToolUse` only) is `deny` to refuse the call, `ask` to require a confirmation prompt, or `allow` to skip the prompt. `allow` does not override `deny` or `ask` rules in `permissions`. When hooks disagree, `deny` wins over `ask`, and `ask` over `allow`.
- `updatedInput` (`PreToolUse` only) replaces the tool's arguments. The new arguments are validated and permission-checked like the original ones.
- `additionalContext` is added to the model's context after the tool result or the prompt.

Subagents run `PreToolUse` and `PostToolUse` hooks for their tool calls. `Stop` and `UserPromptSubmit` belong to the main agent, and scheduled turns skip `UserPromptSubmit`.

## Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": ".ai-agent/hooks/check-command.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": ".ai-agent/hooks/tests-pass.sh" }
        ]
      }
    ]
  }
}
```

`timeout` is in seconds; the default is ten minutes. Hooks from user, project, local and managed settings are all combined.

## Failure modes and security notes

- A hook is a command that runs with your account's rights every time its event occurs, without a prompt. A project's `.ai-agent/settings.json` can define hooks, so read the hooks of a repository before working in it, as you would its scripts.
- Hooks run on the machine the server runs on. They are skipped for remote workspaces and when `AUTH_ENABLED=true`; the server log says so once.
- A hook that cannot start, times out, exits with a code other than 0 or 2, or prints JSON that is not a hook answer is logged and ignored. A broken hook does not stop the agent, so do not rely on a hook alone to enforce a rule; use `permissions.deny` for that.
- Only `type: "command"` hooks and the four events above run. Other hook types and events in a settings file are skipped with one log line each.
- A `systemMessage` in a hook's JSON answer is written to the server log only.
- When a hook ends a turn, the reason appears at the end of the reply while the turn is live. It is stored for the model, but is not shown again when the session is reloaded.

## Source map

- `src/core/hooks/types.ts` — settings shape, hook input, and the JSON answer schema.
- `src/core/hooks/hooks.ts` — matching, running, and combining the answers of an event's hooks.
- `src/core/hooks/exec-command-hook.ts` — running one command with the event on stdin.
- `src/core/hooks/session-hooks.ts` — which sessions run hooks; `UserPromptSubmit`.
- `src/core/hooks/messages.ts` — what a hook result adds to the transcript.
- `src/services/tools/StreamingToolExecutor.ts` — `PreToolUse` and `PostToolUse` around a tool call.
- `src/core/query.ts` — `Stop` hooks and ending a turn a hook stopped.
- `src/core/can-use-tool.ts` — a hook's `allow` / `ask` decision in the permission check.
