/**
 * Headless CLI — NDJSON over stdio (structuredIO / print-mode).
 *
 * Usage:
 *   npm run cli -- --workspace /path/to/project
 *   echo '{"type":"user","text":"hello"}' | npm run cli
 *
 * Stdout: one `@ai-agent/protocol` OutgoingMessage per line.
 * Stdin:  ClientMessage NDJSON (`user`, `control_response`, …).
 * Stderr: boot logs only.
 */
import type { RunAgentFn } from '../core/types.js'
import { resolveDefaultWorkspace } from '../core/workspace.js'
import { createSession, getSession } from '../session/index.js'
import { createStdioTransport } from '../server/stdio-transport.js'
import { readStdioClientMessages } from '../server/stdio-input.js'
import { runChatTurn } from '../turn/run-chat-turn.js'
import { isCloudWorkspacesEnabled } from '../execution/providers/cloud/config.js'
import { parseCloudEnvironmentId } from '../execution/providers/cloud/cloud-provider.js'
import { resolveWorkspaceContext } from '../services/cloud-workspaces/turn-scope.js'

export async function startStdioAgent(runAgent: RunAgentFn): Promise<void> {
  const cwd = resolveDefaultWorkspace()
  const transport = createStdioTransport()
  let session = createSession()
  let emitHandshake = true

  console.error(`[cli] workspace=${cwd} session=${session.id}`)

  for await (const msg of readStdioClientMessages()) {
    if (msg.session_id) {
      const existing = getSession(msg.session_id)
      if (existing) session = existing
    }

    console.error(
      `[cli] turn session=${session.id.slice(0, 8)} text=${msg.text.slice(0, 80)}`,
    )
    if (
      isCloudWorkspacesEnabled() &&
      !parseCloudEnvironmentId(session.workspace?.environmentId)
    ) {
      throw new Error(
        'CLI cannot run in the Cloud profile without a bound Cloud WorkspaceHandle.',
      )
    }
    const workspace = resolveWorkspaceContext(
      session.workspace,
      session.workspace?.cwd ?? cwd,
    )

    await runChatTurn({
      message: msg.text,
      session,
      workspace,
      runAgent,
      transport,
      images: msg.images,
      emitHandshake,
    })
    emitHandshake = false
  }
}
