/**
 * Shared process bootstrap.
 * Mode adapters call this once before loading agent/server/cli/acp.
 */
import { resolveDefaultWorkspace } from '../utils/workspace/workspace.js'

export type BootMode = 'http' | 'stdio' | 'acp' | 'worker-stdio'

let initPromise: Promise<void> | null = null

function bootLog(message: string): void {
  console.error(message)
}

function loadEnvFile(): void {
  if (typeof process.loadEnvFile !== 'function') {
    return
  }
  try {
    process.loadEnvFile('.env')
    bootLog('[start] Loaded .env')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      bootLog(`[start] Failed to load .env: ${(err as Error).message}`)
    }
  }
}

function logBootDiagnostics(): void {
  // Undefined = ripgrep gets surprise-permissive defaults in utils/glob.ts.
  bootLog(
    `[start] GLOB_NO_IGNORE=${process.env.GLOB_NO_IGNORE ?? '(unset → defaults true)'} ` +
      `GLOB_HIDDEN=${process.env.GLOB_HIDDEN ?? '(unset → defaults true)'}`,
  )
  bootLog(
    `[start] ANALYTICS_URL=${process.env.ANALYTICS_URL ?? '(unset → telemetry disabled)'}`,
  )
}

/**
 * Memoized boot: env, workspace fail-fast, diagnostic logs, ENTRYPOINT latch.
 * Safe to call from multiple paths; runs once per process.
 */
export function init(mode: BootMode): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      process.env.AI_AGENT_ENTRYPOINT = mode
      loadEnvFile()
      logBootDiagnostics()

      try {
        const workspace = resolveDefaultWorkspace()
        bootLog(`[start] workspace = ${workspace}`)
      } catch (err) {
        bootLog(
          `[start] Failed to resolve workspace: ${(err as Error).message}`,
        )
        process.exit(1)
      }
    })()
  }
  return initPromise
}
