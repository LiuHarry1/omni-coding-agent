# `@ai-agent/client`

TypeScript client for the coding agent HTTP API — discover skills, invoke
skills directly, and run free-form chat (buffered or streaming).

Works in Node 18+, browsers, Bun, edge runtimes. No `EventSource` dependency.

## Install

```jsonc
// your project's package.json
{
  "dependencies": {
    "@ai-agent/client": "file:../baize/sdks/typescript"
  }
}
```

```bash
npm install && npm run build -w sdks/typescript   # from the repo root
```

## Quick start (SSO deploy)

```ts
import { AgentClient, collectText } from "@ai-agent/client";

const agent = new AgentClient({
  baseURL: "http://localhost:4567",
  jwtSecret: process.env.AGENT_JWT_SECRET!,
  email: "you@company.com",   // decides the pinned workspace
});

const { skills } = await agent.listSkills();
const { text } = await agent.chatComplete({ message: "Hello" });

for await (const ev of agent.chat({ message: "find TODOs" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.delta);
}
```

Or pass a ready-made token: `{ baseURL, token: "eyJ..." }`.

IntelliJ / ACP integration: [`docs/readme/integrations/intellij-acp.md`](../docs/readme/integrations/intellij-acp.md). VS Code: [`docs/readme/integrations/vscode-acp.md`](../docs/readme/integrations/vscode-acp.md).

## API overview

| Layer | Methods |
|-------|---------|
| Discovery | `health()`, `listSkills()`, `listAgents()` |
| Skills | `invokeSkill()` (buffered), `invokeSkillStream()` (SSE) |
| Chat | `chatComplete()` (buffered), `chat()` (SSE) |
| Helpers | `collectText(events)`, `mintJwt()` (Node only) |

## Three use cases (examples + tests)

```bash
npm run example              # all three
npm run example -- skills    # list all skills
npm run example -- chat      # multi-turn same session
npm run example -- wetrack    # wetrack skill (streaming)

npm test                     # integration tests (same 3 cases)
```

Env vars: `AGENT_BASE_URL`, `AGENT_JWT_SECRET`, `AGENT_EMAIL`.
Set `AGENT_SKIP_LIVE=1` to skip integration tests.

## Cancellation

Streaming methods accept an optional `AbortSignal`. Aborting that signal only
closes the local subscription; it does not cancel a durable Run:

```ts
const ac = new AbortController();
for await (const ev of agent.chat({ message: "..." }, ac.signal)) { /* … */ }
ac.abort();
```

Use a stable Run handle for reconnect and explicit cancellation:

```ts
const run = await agent.startChatRun({ message: "long task" });
let lastSeq = 0;
for await (const event of run.events) {
  lastSeq = Number(event.event_id ?? lastSeq);
}

// Resume after a network interruption.
for await (const event of agent.streamRun(run.run_id, lastSeq)) {
  lastSeq = Number(event.event_id ?? lastSeq);
}

const status = await agent.getRun(run.run_id);
await agent.cancelRun(run.run_id);
```

Run streams are delivered at least once. Persist the last applied
`event_id` and deduplicate on reconnect.

## Errors

```ts
try {
  await agent.invokeSkill("nope");
} catch (e) {
  if (e instanceof AgentClientError) {
    console.error(e.message, e.status, e.body);
  }
}
```

HTTP errors throw `AgentClientError`. SSE `{ type: "error" }` events are
yielded in the stream (or thrown by `collectText()`).

## Type exports

```ts
import type { AgentEvent, SkillSummary, ChatRequest } from "@ai-agent/client";
```
