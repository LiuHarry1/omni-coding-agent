# Slash commands

Last verified: 2026-09-13

## Overview

Slash commands provide one invocation surface for built-ins, Markdown command templates, and skills. A command is recognized only when the trimmed message is a single `/name` line followed by optional arguments.

## How it works

The registry loads built-ins, command files, skills, and plugin contributions for the active workspace. Built-in names are protected. For other duplicates, a skill replaces a command; command precedence is managed over deepest project over user over plugin.

Markdown commands substitute `$ARGUMENTS`, positional values such as `$1`, and named arguments, then expand `!` shell directives and `@file` directives before running inline on the main agent. Skills expand their body and run inline or in a fork according to their `context`. Raw skill arguments are appended so a skill cannot accidentally discard the request.

Prompts offered by connected MCP servers are also slash commands, named `/mcp__<server>__<prompt>`. They are resolved against the live servers rather than this registry; see [MCP servers](mcp.md).

Built-ins are `/help` and `/commands`, `/plan`, `/plugins`, `/compact [focus]`, and `/summary`. The HTTP/UI listing is available through `GET /slash-commands`.

## Configuration and API

Create `.ai-agent/commands/fix-lint.md`; the filename becomes `/fix-lint`:

```markdown
---
description: Fix lint findings in a requested scope
argument-hint: "[scope]"
arguments: "scope"
model: optional-model-id
---

Run the project linter for $scope, fix verified failures, and report the checks.
```

Names must match letters, digits, underscores, and hyphens and must start with a letter or digit. The body must be non-empty. Description defaults to the first non-empty body line, capped at 100 characters.

`GET /slash-commands` returns public entries with `name`, `description`, `kind`, and optional `argumentHint`; skill entries also expose `context`, and MCP prompts (`kind: "mcp-prompt"`) expose `server`.

## Failure modes and security notes

- Unknown names return an explicit unknown result with available names; malformed slash text passes through as an ordinary message.
- Invalid YAML, invalid filenames, and empty command bodies are skipped and logged.
- Built-in names cannot be shadowed by commands or skills. On a non-built-in collision, skills take precedence.
- `!` directives execute shell commands during expansion and `@file` directives read workspace content; command authors therefore hold code-execution and data-access capability subject to the underlying tool and filesystem controls.
- A failed skill expansion returns an immediate error reply instead of entering the agent loop.

## Source map

- `src/commands/slashRegistry.ts` — unified registry, precedence, built-ins, and public shape.
- `src/commands/dispatcher.ts` — parsing and routing.
- `src/commands/loadCommandsFromFiles.ts` — Markdown schema and merge behavior.
- `src/commands/argumentSubstitution.ts` — positional and named substitutions.
- `src/commands/promptExpansion.ts` — shell and file directives.
- `src/skills/expand.ts` — inline/fork skill expansion.
- `src/server/router.ts` — `GET /slash-commands`.
