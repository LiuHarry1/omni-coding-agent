// A stdio MCP server for tests. `pid` tells one process from the next,
// `crash` kills it mid-session, and while the file named by MCP_TEST_DOWN
// exists the server refuses to start at all.
import * as fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const down = process.env.MCP_TEST_DOWN
if (down && fs.existsSync(down)) process.exit(1)

// The client hung up; there is nobody left to answer.
process.stdout.on('error', () => process.exit(0))

const server = new McpServer({ name: 'fake-stdio', version: '1.0.0' })
server.registerTool('pid', { description: 'This process' }, () => ({
  content: [{ type: 'text', text: String(process.pid) }],
}))
server.registerTool('crash', { description: 'Die' }, () => {
  process.exit(1)
})

await server.connect(new StdioServerTransport())
