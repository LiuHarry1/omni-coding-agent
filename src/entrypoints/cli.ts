/**
 * Mode dispatcher — peek argv, init once, dynamic-import only what that mode needs.
 */
import { init, type BootMode } from './init.js'

function detectMode(argv: string[]): BootMode {
  if (argv.includes('--worker-stdio')) return 'worker-stdio'
  if (argv.includes('--acp')) return 'acp'
  if (argv.includes('--stdio')) return 'stdio'
  return 'http'
}

async function main(): Promise<void> {
  const mode = detectMode(process.argv.slice(2))
  await init(mode)

  bootLog(`[start] mode=${mode}`)

  if (mode === 'worker-stdio') {
    const { runWorkerStdio } = await import('../worker/main.js')
    runWorkerStdio()
    return
  }

  if (mode === 'stdio') {
    const [{ startStdioAgent }, { runAgent }] = await Promise.all([
      import('../cli/main.js'),
      import('../core/agent.js'),
    ])
    await startStdioAgent(runAgent)
    return
  }

  if (mode === 'acp') {
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    })
    const [{ startAcpAgent }, { runAgent }] = await Promise.all([
      import('../acp/main.js'),
      import('../core/agent.js'),
    ])
    await startAcpAgent(runAgent)
    return
  }

  const { startServer } = await import('../server/index.js')
  startServer()
}

function bootLog(message: string): void {
  console.error(message)
}

void main().catch(err => {
  console.error(`[start] Fatal: ${(err as Error).message}`)
  process.exit(1)
})
