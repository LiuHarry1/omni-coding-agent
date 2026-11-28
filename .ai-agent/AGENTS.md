# Agent instructions

Guidelines for AI coding agents working in this repository.

## Workflow

- Read existing code and project conventions before changing anything.
- Prefer small, focused changes; avoid unrelated refactors.
- Do not commit secrets, credentials, or private keys.

## Commands

- Use the project's documented install, build, lint, and test commands.
- Run relevant checks after making changes when practical.
- Cloud agents install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts` after `ripgrep` is on `PATH`. Node.js 22 is required. The web UI is `npm run dev:web` (port 5173) with the backend from `npm start` (port 4567).
- `npm test` renders one chart PNG when `google-chrome` is on `PATH`. On Cloud Agent VMs that command is a long-lived desktop wrapper, so export `CHROME_PATH=/opt/google/chrome/chrome` before the suite. Without a Chrome binary the PNG case is skipped.

## Style

- Match the local language, formatting, and naming already used in the repo.
- Keep comments and docs concise; update them only when behavior changes.
