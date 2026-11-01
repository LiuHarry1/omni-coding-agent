# Coding Agent

> Formerly known as Baize (白泽).
>
> **First time here?** Start with the [Quick Start](docs/readme/getting-started.md) (download the code → install dependencies → run the desktop app → pair a browser).

A locally runnable AI coding assistant for chat, reading and editing code, tool use, and browser automation. Supports the **desktop app**, **Web UI**, and **VS Code / Cursor / IntelliJ** integrations.

---

## How do you want to use it?

| I want to… | Start here |
|--------|------------|
| Get started and try browser automation | [Quick Start](docs/readme/getting-started.md) |
| Develop the frontend locally or debug the agent | [Local Development](docs/readme/development.md) |
| Use Coding Agent in VS Code or Cursor | [VS Code Integration](docs/readme/integrations/vscode-acp.md) |
| Use Coding Agent in IntelliJ | [IntelliJ Integration](docs/readme/integrations/intellij-acp.md) |
| Deploy Coding Agent to a private network | [Docker Deployment](deploy/README.md) |
| Extend Coding Agent or add tools | [Agent Source Guide](src/README.md) |

---

## Core capabilities

- **Coding assistance** — Read and edit files, run shell commands, search the codebase, and explore in parallel with subagents
- **Browser automation** — Open web pages, click controls, fill forms, take screenshots, and read page content; can control your own Chrome profile for sites that require authentication
- **Extensibility** — Skills, Commands, Plugins, MCP, and custom Subagents
- **Multiple interfaces** — Electron desktop app, Web UI, ACP (IDE sidebar), and HTTP API / SDK
- **Memory and compaction** — Session memory, Auto memory, and automatic context compaction

---

## Five-minute desktop quick start

**Prerequisites:** Node.js 20+ and API configuration supplied by your team (see `.ai-agent/settings.json`)

```bash
git clone <your-repository-url>
cd coding-agent
npm install   # root + workspaces (web, protocol, sdks/typescript)
cp .ai-agent/settings.example.json .ai-agent/settings.json   # Add your API configuration
npm run desktop:dev
```

When the desktop window opens, select **Browser Automation** and enter a prompt such as:

> Open https://example.com and tell me the page title.

For sites that require authentication, see extension mode and pairing in the [Browser Automation Guide](docs/readme/browser.md).

---

## Configuration quick reference

| Configuration | Location |
|----------|--------|
| Model API (`baseURL`, `apiKey`, `model`) | `.ai-agent/settings.json` |
| Runtime settings such as the port and workspace path | `.env` (optional; see `.env.example`) |
| Browser mode (`isolated` / `extension`) | `browser` in `.ai-agent/settings.json` |

User-level configuration: `~/.ai-agent/settings.json`. Project-level configuration: `<workspace>/.ai-agent/settings.json`, which takes precedence.

---

## Common commands

| Command | Description |
|------|------|
| `npm run desktop:dev` | Start the desktop app (recommended for new users) |
| `npm start` | Start only the agent backend (`:4567`) |
| `npm run dev:web` | Start the Web UI in development mode (run `npm start` in another terminal) |
| `npm run cloud:start` | Build and start the local Docker-backed Cloud profile |
| `npm run browser:pair` | Check that the Chrome extension can reach the agent |
| `npm run desktop:pack` | Package the desktop installer |
| `npm run desktop:pack:win` | Package the Windows installer |
| `npm run build:web` | Build the frontend into `web/dist` |
| `npm run docs:dev` | Start the documentation site in development mode |
| `npm run docs:build` | Build the documentation site |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run format` | Format the code with Prettier |

---

## Browser automation

Coding Agent can open web pages, click controls, fill forms, take screenshots, and read page content. By default, it launches an isolated browser with no configuration required. It can also control **your own Chrome profile**, allowing access to authenticated sites without login scripts.

```bash
npm start                 # Isolated mode works out of the box
npm run browser:pair      # Check the extension, to use your own Chrome profile
```

For complete instructions, see [docs/readme/browser.md](docs/readme/browser.md).

---

## Production deployment

Deploy the Web UI with Docker. See [deploy/README.md](deploy/README.md) for details.

```bash
docker compose -f deploy/docker-compose.admin.yml --env-file deploy/.env up -d
# Open http://localhost:9999 (credentials: WEB_USERNAME / WEB_PASSWORD)
```

---

## Project structure

```
├── start.js              # Unified entry point (HTTP / --acp / --stdio)
├── src/                  # Agent core (tools / core / services / server)
│   ├── tests/            #   Legacy test scripts, run through vitest (suites/, suites/live/)
│   └── dev/              #   Developer utilities (browser pairing, dev Chrome)
├── web/                  # React frontend (npm workspace)
├── desktop/              # Electron shell + electron-builder config
├── chrome-extension/     # Browser extension (extension mode)
├── protocol/             # Shared wire protocol (npm workspace)
├── sdks/                 # Client SDKs: typescript/ (npm workspace), python/
├── analytics/            # Telemetry service (Python / FastAPI)
├── integrations/         # Third-party bridges (stpl-lsp-bridge)
├── evals/                # SWE-bench / aider-polyglot evaluation harnesses
├── deploy/               # Docker images, compose files, workspace seeds
├── scripts/              # Build / staging scripts
├── docs/                 # VitePress documentation
└── .ai-agent/            # Project-level skills / agents / commands / settings.example.json
```

---

## Documentation index

### User guides

| Topic | Documentation |
|------|------|
| Installation and first run | [docs/readme/getting-started.md](docs/readme/getting-started.md) |
| Browser automation | [docs/readme/browser.md](docs/readme/browser.md) |
| Local Web development | [docs/readme/development.md](docs/readme/development.md) |
| VS Code / Cursor | [docs/readme/integrations/vscode-acp.md](docs/readme/integrations/vscode-acp.md) |
| IntelliJ IDEA | [docs/readme/integrations/intellij-acp.md](docs/readme/integrations/intellij-acp.md) |
| Docker deployment | [deploy/README.md](deploy/README.md) |
| Client SDK | [sdks/typescript/](sdks/typescript/) |

### Development and architecture

| Topic | Documentation |
|------|------|
| Documentation overview | [docs/README.md](docs/README.md) |
| Agent source and extensions | [src/README.md](src/README.md) |
| System architecture | [docs/architecture/](docs/architecture/) |
| Memory system | [docs/architecture/memory-guide.md](docs/architecture/memory-guide.md) |
| Execution architecture | [docs/architecture/execution.md](docs/architecture/execution.md) |

---

## License

Licensed under the [MIT License](LICENSE). Copyright © 2026 Harry Liu.
