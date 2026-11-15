# Primary agents

Last verified: 2026-09-13

## Overview

A primary agent is a Markdown-defined specialist that runs on the main conversation thread. It supplies the main system prompt and tool policy while retaining the session, transport, and ability to invoke subagents. Agents without `mode: primary` are subagents by default.

## How it works

Agent files are loaded from plugin, user, project, and managed sources. Duplicate names resolve in ascending precedence: plugin, user, project, managed. Plugins cannot override built-in agent types. Only active definitions whose mode is `primary` enter the picker pool.

The picker independently resolves visible interaction modes and visible primary profiles. Selecting a primary forces Agent mode. A new session receives the configured default only if that choice remains visible; otherwise it falls back to the default coding agent or first allowed interaction mode as applicable.

## Configuration

Create `.ai-agent/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Review code before merge
label: Code Reviewer
mode: primary
modelTier: large
disallowedTools: search-memory_*
omitProjectRules: false
---

You are a code-review specialist. Inspect evidence before reporting findings.
```

Supported frontmatter includes `name`, required `description`, `mode`, `tools` or `disallowedTools`, `maxSteps`, `model`, `modelTier`, `label`, and `omitProjectRules`. The Markdown body is the system prompt. `tools` and `disallowedTools` are mutually exclusive.

Picker settings:

```json
{
  "agents": {
    "picker": {
      "modes": ["agent", "ask", "plan"],
      "primaries": ["reviewer"]
    },
    "default": {
      "mode": "agent",
      "agentType": "reviewer"
    }
  }
}
```

Omitting `modes` shows all modes; `[]` hides mode rows. Omitting `primaries` shows all primary agents; `[]` shows none. `agentType: null` means the default coding profile.

## Failure modes and security notes

- Missing names are skipped; missing descriptions, empty bodies, or simultaneous tool allow/deny lists produce load errors.
- `Plan`, `Explore`, `agent`, `ask`, `plan`, and `general-purpose` are reserved primary names.
- A primary tool allow-list silently removes the Agent tool name from that list, but primary deny-lists are otherwise kept as authored.
- `omitProjectRules: true` intentionally removes workspace rules from the profile prompt; use it only for profiles that should not receive those instructions.
- A requested API mode or agent type outside the resolved picker allowlist is rejected or ignored by the relevant session path.

## Source map

- `src/tools/AgentTool/mergeAgents.ts` — parsing, validation, precedence, and reserved names.
- `src/server/agent-picker.ts` — picker visibility and defaults.
- `src/server/agent-picker-workspace.ts` — workspace resolution and session application.
- `src/prompts/agent-profile.ts` — primary system-prompt assembly.
- `src/core/types.ts` — `AgentDefinition` and session `agentType`.
- `src/tests/test-primary-agent-parse.ts` — parser and prompt behavior checks.
