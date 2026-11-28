# Desktop Computer Use

Drive native apps on your Mac: open them, read the window, click, type, and check the result. The Desktop Computer Use agent does this through [Cua Driver](https://cua.ai/docs/cua-driver/guides/connect-your-agent) (`cua-driver mcp`). It is separate from [Browser Automation](browser.md), which drives Chrome with the built-in `browser_*` tools.

This guide is for the desktop app. Select **Desktop Computer Use** in the agent picker.

## Prerequisites

| Item | Requirement |
| --- | --- |
| OS | macOS (Accessibility + Screen Recording) |
| Desktop app | `npm run desktop:dev`, or the packaged app |
| Cua Driver | Installed and granted permissions (below) |
| LLM API | Configured in `.ai-agent/settings.json` |

## 1. Install Cua Driver

In Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver permissions grant
```

The installer puts `cua-driver` on `~/.local/bin` and installs `CuaDriver.app`. `permissions grant` opens System Settings so you can turn on **Accessibility** and **Screen Recording** for **CuaDriver.app**. Grant those to CuaDriver, not to Terminal or the Coding Agent app.

Check:

```bash
export PATH="$HOME/.local/bin:$PATH"
cua-driver call check_permissions
```

Both `accessibility` and `screen_recording` should be `true`.

There is no in-app installer yet. Run the two commands above once per machine. The permission dialogs still need a click in System Settings.

## 2. Register the MCP server

The agent only sees Cua tools when `cua-driver` is configured as an MCP server.

Dev checkout — copy the example if you do not already have a local file, then confirm this block is present in `.ai-agent/settings.local.json`:

```json
{
  "mcpServers": {
    "cua-driver": {
      "command": "cua-driver",
      "args": ["mcp"]
    }
  }
}
```

The same block is in `.ai-agent/settings.example.json`. `settings.local.json` overrides `settings.json` and is the right place for this machine.

Packaged desktop app: the workspace seed ships the same server in `deploy/desktop/workspace-seed/.ai-agent/settings.local.json`. After you change MCP settings, restart the app.

If the desktop app cannot find `cua-driver`, set `command` to the absolute path from `command -v cua-driver` (usually `~/.local/bin/cua-driver`). A packaged app often does not include `~/.local/bin` on `PATH`.

## 3. Start a Desktop Computer Use session

1. Start the app: `npm run desktop:dev`.
2. Choose **Desktop Computer Use** (not Browser Automation or Personal Assistant).
3. Ask it to operate a real app.

Example:

> Open TextEdit and write “hello from desktop”.

> Open Calculator and compute 19 times 23.

The agent uses `cua-driver_*` tools: list windows, snapshot a window, click or type by accessibility token, then verify. Keep the Mac unlocked. A locked screen or sleeping display hides app windows from accessibility, and actions are refused until you unlock.

## What you can ask for

| Task | What the agent uses |
| --- | --- |
| Open an app and type | `launch_app`, `set_value` / `type_text`, `verify_state` |
| Switch or resize windows | `list_windows`, `bring_to_front`, `set_window_frame` |
| Click what is on screen | `get_window_state` or `get_desktop_state`, then `click` |
| Clipboard, keys, scroll | `clipboard_*`, `hotkey`, `press_key`, `scroll` |
| Several steps at once | `run_steps` |
| A page in Chrome via Cua | `cua-driver` `browser_*` tools |

Prefer accessibility tokens from a fresh `get_window_state` over raw pixel clicks. Tokens go stale after the UI changes; the agent should snapshot again.

`screenshot_quality` is only valid with `screenshot_format: "jpeg"`. PNG is the default and must not include `screenshot_quality`.

## Safety

The agent can click and type in any app you can see. Do not ask it to quit Cursor, Terminal, this app, or a browser you are using unless you name that exact target. It will not ask for confirmation on a task you already gave it.

Personal Assistant does not include the Cua tools. Use Desktop Computer Use for native apps.
