/**
 * What argv decides before anything else is loaded: `--version` and `--help`
 * answer and exit, and `--acp` keeps logs off stdout. No imports, so both
 * entries (`start.js` and the bundled agent) stay fast for these flags.
 */
export function handleEarlyArgs(opts: {
  /** How the program is started, for the usage line. */
  program: string
  readVersion: () => string
}): void {
  const args = process.argv.slice(2)

  if (args.includes('--version') || args.includes('-v')) {
    console.log(opts.readVersion())
    process.exit(0)
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: ${opts.program} [--acp | --stdio | --worker-stdio]

Modes:
  (default)       HTTP server on PORT (default 4567)
  --acp           Agent Client Protocol (stdout JSON-RPC)
  --stdio         NDJSON stdio agent
  --worker-stdio  Execution-plane worker (FS/shell/LSP over stdio NDJSON)`)
    process.exit(0)
  }

  // ACP uses stdout for JSON-RPC: boot logs go to stderr only.
  if (args.includes('--acp')) {
    console.log = console.error
    console.info = console.error
    console.warn = console.error
    console.debug = console.error
  }
}
