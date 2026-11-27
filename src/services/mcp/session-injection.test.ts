import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  InjectedMcpError,
  validateInjectedMcpServers,
} from './session-injection.js'

const chatbot = { origin: 'chatbot' as const, name: 'Report' }
const user = { origin: 'user' as const, name: 'Mine' }

describe('validateInjectedMcpServers', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    process.env.SESSION_MCP_INJECTION_ENABLED = 'true'
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('accepts http servers for chatbot workspaces', () => {
    expect(
      validateInjectedMcpServers(
        {
          kb_docs: {
            url: 'https://baix.advantest.com/mcp/docs',
            transport: 'http',
            extra: 'dropped',
          },
          asst_tdc: {
            url: 'https://mcp.example.com/tdc',
            transport: 'sse',
            headers: { Authorization: 'Bearer x', bad: 1 },
          },
        },
        chatbot,
      ),
    ).toEqual({
      kb_docs: { url: 'https://baix.advantest.com/mcp/docs', transport: 'http' },
      asst_tdc: {
        url: 'https://mcp.example.com/tdc',
        transport: 'sse',
        headers: { Authorization: 'Bearer x' },
      },
    })
  })

  it('treats legacy work- workspaces as chatbot', () => {
    expect(
      validateInjectedMcpServers({}, { name: 'work-1ef0f7ad' }),
    ).toEqual({})
  })

  it.each([
    ['disabled', () => delete process.env.SESSION_MCP_INJECTION_ENABLED, chatbot],
    ['user workspace', () => {}, user],
    ['no workspace', () => {}, undefined],
  ])('rejects when %s', (_label, setup, record) => {
    setup()
    expect(() =>
      validateInjectedMcpServers(
        { kb: { url: 'https://baix.advantest.com/mcp/a' } },
        record,
      ),
    ).toThrow(InjectedMcpError)
  })

  it('rejects metadata hosts, non-http urls and stdio', () => {
    for (const server of [
      { url: 'http://169.254.169.254/latest' },
      { url: 'file:///etc/passwd' },
      { command: 'node' },
    ]) {
      expect(() =>
        validateInjectedMcpServers({ kb: server }, chatbot),
      ).toThrow(InjectedMcpError)
    }
  })

  it('rejects bad names and non-objects', () => {
    expect(() => validateInjectedMcpServers([], chatbot)).toThrow(InjectedMcpError)
    expect(() =>
      validateInjectedMcpServers(
        { 'bad name': { url: 'https://baix.advantest.com/mcp' } },
        chatbot,
      ),
    ).toThrow(InjectedMcpError)
  })
})
