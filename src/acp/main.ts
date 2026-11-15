/**
 * ACP agent entry — JSON-RPC 2.0 over stdio.
 *
 * Usage:
 *   npm run acp -- --workspace /path/to/project
 *
 * Configure in JetBrains / VS Code ACP client as the agent command.
 */
import type { RunAgentFn } from '../core/types.js'
import { resolveDefaultWorkspace } from '../utils/workspace/workspace.js'
import { runAcp } from './run-acp.js'

export async function startAcpAgent(runAgent: RunAgentFn): Promise<void> {
  const cwd = resolveDefaultWorkspace()
  console.error(`[acp] workspace=${cwd}`)

  const { connection, agent } = runAcp(runAgent, cwd)

  async function shutdown(): Promise<void> {
    await agent.dispose().catch(err => {
      console.error('[acp] cleanup failed:', (err as Error).message)
    })
    process.exit(0)
  }

  connection.closed.then(shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdin.resume()
}
