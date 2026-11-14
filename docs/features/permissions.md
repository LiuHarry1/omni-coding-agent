# Permissions

Last verified: 2026-11-14

## Overview

Filesystem permissions protect FileRead, Grep, Glob, LSP, FileEdit, and FileWrite operations. Command permissions decide which Bash and PowerShell commands run without asking. Both are separate from the session's Agent, Ask, and Plan interaction modes.

## How it works

Every candidate path is checked both lexically and through its real path, or the nearest existing real ancestor for a new file. Deny rules run first. The workspace, session “Always allow” directories, and selected internal read/write roots are then allowed. Remaining paths may match an allow rule, prompt the desktop user, or be denied according to `defaultMode`.

`default` asks for out-of-workspace access and supports Allow, Always allow, or Reject. `dontAsk` turns unresolved prompts into denials. `bypassPermissions` allows outside paths, but explicit deny rules still win. An unanswered prompt times out after five minutes.

## Shell commands

A command line is split into the simple commands it runs (`&&`, `||`, `;`, `|`, `&`, newlines), and each one is judged on its own:

1. A `deny` rule on any part refuses the whole line.
2. An `ask` rule on any part asks, even when an allow rule also matches and even under `bypassPermissions`.
3. The line runs without asking when every part is covered by an `allow` rule or is recognised as read-only (`git status`, `ls`, `cat`, `grep`, `rg`, and so on, checked flag by flag), and no output is redirected outside the working directories.
4. Anything else asks in `default` mode. The prompt offers Allow, Always allow, or Reject; Always allow adds the suggested rule, such as `Bash(npm run:*)`, to the project's local settings.

Rule content is an exact command (`Bash(git status)`), a prefix (`Bash(npm run:*)`), or a wildcard (`Bash(git commit *)`). `Bash` alone covers every command. Leading variables on a short safe list (`NODE_ENV`, `TZ`, ...) and the wrappers `timeout`, `time`, `nice`, `stdbuf`, `nohup` are looked through for allow rules; deny and ask rules look through every leading variable assignment.

A line the parser does not follow completely (command or process substitution, `${...}`, subshells, heredocs, loops and conditions) is never auto-approved by a prefix or wildcard rule or as read-only, though its parts are still checked against deny and ask rules. A read-only command also asks when one of its words points outside the readable directories (an absolute path, `~`, or `..`).

Where nobody can answer — `dontAsk` mode and scheduled turns — a command under an `ask` rule is refused and a command no rule mentions runs, as it did before command rules existed. To keep that earlier behaviour in `default` mode as well, add `"Bash"` to `allow`.

Subagents ask through the same prompt as the main agent.

## Configuration

```json
{
  "permissions": {
    "defaultMode": "default",
    "additionalDirectories": ["../shared"],
    "allow": ["Read(docs/**)", "Edit(src/generated/**)", "Bash(npm run:*)"],
    "ask": ["Bash(git push:*)"],
    "deny": ["Read(.env)", "Edit(.env)", "Write(.env)", "Bash(rm -rf:*)"]
  }
}
```

Rules use `Tool` or `Tool(pattern)`. `Read` rules also apply to Grep, Glob, and LSP; Edit and Write rules apply across both write tools. A single leading slash is project-relative; `~/`, drive-letter, and UNC patterns are filesystem-absolute. `PERMISSION_EXTRA_READ_ROOTS` adds comma-separated read roots; deprecated `SANDBOX_EXTRA_READ_ROOTS` is the fallback.

When `AUTH_ENABLED=true`, the effective mode is always `dontAsk`; `allow` and `additionalDirectories` are ignored, while `deny` and `ask` remain active.

## Failure modes and security notes

- “Always allow” persists a directory to user settings when possible and also updates the current session. Persistence failure is logged, but the current decision still succeeds.
- Symlink targets are checked to prevent an allowed-looking path from escaping the boundary.
- Legacy `acceptEdits` and `plan` values are accepted with a warning and treated as `default`.
- This is application-level enforcement for filesystem tools and workspace HTTP operations. A Bash or PowerShell command that was approved, or that runs unasked in `dontAsk` mode, can still access absolute paths unless separately sandboxed; do not treat these rules as tenant isolation.
- Command rules match text. They are a convenience and a guard against mistakes, not a sandbox: an approved interpreter (`node`, `python`, `make`) can do anything.
- Read-only recognition knows Unix commands. PowerShell cmdlets are not on the list, so in `default` mode they ask unless a rule allows them.
- Only tools that implement `checkPermissions` pass through this gate.

## Source map

- `src/utils/permissions/filesystem.ts` — path resolution and allow/ask/deny policy.
- `src/utils/permissions/permission-rules.ts` — rule parsing and pattern matching.
- `src/tools/BashTool/bashPermissions.ts` — command rules and the allow / ask / deny decision.
- `src/tools/BashTool/readOnlyValidation.ts`, `src/utils/shell/readOnlyCommandValidation.ts` — read-only command recognition.
- `src/utils/bash/commands.ts` — splitting a command line into simple commands.
- `src/core/can-use-tool.ts` — prompts, timeout, and Always allow handling.
- `src/core/settings-schema.ts` — validated settings.
- `src/core/permission-mode.ts` — Agent, Ask, and Plan session modes.
- `deploy/README.md` — deployment-specific SSO boundary and limitations.
