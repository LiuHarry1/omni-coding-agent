import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { describe, expect, it, vi } from 'vitest'
import {
  isSessionExpiredError,
  isUnauthorizedError,
  TransportTap,
} from './transport.js'

function fakeTransport() {
  const inner: Transport & { closed: number } = {
    closed: 0,
    start: async () => {},
    send: async () => {},
    close: async () => {
      inner.closed += 1
      inner.onclose?.()
    },
  }
  return inner
}

function tap(remote = true) {
  const inner = fakeTransport()
  const events = {
    onCapabilities: vi.fn(),
    onNotification: vi.fn(),
    onClose: vi.fn(),
  }
  const transport = new TransportTap(inner, events, { remote })
  const client = { onmessage: vi.fn(), onclose: vi.fn(), onerror: vi.fn() }
  Object.assign(transport, client)
  return { inner, events, client }
}

const nextTick = () => new Promise(resolve => setImmediate(resolve))

function httpError(code: number, message: string) {
  return Object.assign(new Error(message), { code })
}

describe('TransportTap', () => {
  it('keeps notifications from the client and reports them', () => {
    const { inner, events, client } = tap()
    inner.onmessage!({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    })

    expect(events.onNotification).toHaveBeenCalledWith(
      'notifications/tools/list_changed',
    )
    expect(client.onmessage).not.toHaveBeenCalled()
  })

  it('passes requests and responses through', () => {
    const { inner, events, client } = tap()
    const ping = { jsonrpc: '2.0' as const, id: 7, method: 'ping' }
    const answer = { jsonrpc: '2.0' as const, id: 3, result: { tools: [] } }
    inner.onmessage!(ping)
    inner.onmessage!(answer)

    expect(client.onmessage.mock.calls).toEqual([[ping], [answer]])
    expect(events.onNotification).not.toHaveBeenCalled()
    expect(events.onCapabilities).not.toHaveBeenCalled()
  })

  it('reads what the server offers off the initialize response', () => {
    const { inner, events, client } = tap()
    inner.onmessage!({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { resources: {}, prompts: { listChanged: true } },
        serverInfo: { name: 's', version: '1' },
      },
    })

    expect(events.onCapabilities).toHaveBeenCalledWith({
      tools: false,
      resources: true,
      prompts: true,
    })
    expect(client.onmessage).toHaveBeenCalledTimes(1)
  })

  it('closes a remote connection after three network errors in a row', async () => {
    const { inner, events, client } = tap()
    inner.onerror!(new Error('read ECONNRESET'))
    inner.onerror!(new Error('SSE stream disconnected: TypeError: terminated'))
    await nextTick()
    expect(inner.closed).toBe(0)

    inner.onerror!(new Error('connect ECONNREFUSED 127.0.0.1:1'))
    await nextTick()
    expect(inner.closed).toBe(1)
    expect(client.onclose).toHaveBeenCalledTimes(1)
    expect(events.onClose).toHaveBeenCalledTimes(1)
    expect(client.onerror).toHaveBeenCalledTimes(3)
  })

  it('starts counting again after an unrelated error', async () => {
    const { inner } = tap()
    inner.onerror!(new Error('read ECONNRESET'))
    inner.onerror!(new Error('read ECONNRESET'))
    inner.onerror!(new Error('Unexpected token < in JSON'))
    inner.onerror!(new Error('read ECONNRESET'))
    await nextTick()
    expect(inner.closed).toBe(0)
  })

  it('closes at once when the transport gave up or the session is gone', async () => {
    const gaveUp = tap()
    gaveUp.inner.onerror!(
      new Error('Maximum reconnection attempts (2) exceeded.'),
    )
    await nextTick()
    expect(gaveUp.inner.closed).toBe(1)

    const expired = tap()
    expired.inner.onerror!(
      httpError(
        404,
        'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}',
      ),
    )
    await nextTick()
    expect(expired.inner.closed).toBe(1)
  })

  it('leaves a local process to end its own connection', async () => {
    const { inner } = tap(false)
    for (let i = 0; i < 5; i++) inner.onerror!(new Error('write EPIPE'))
    await nextTick()
    expect(inner.closed).toBe(0)
  })
})

describe('error classification', () => {
  it('takes a 404 for an expired session only with the JSON-RPC code', () => {
    expect(
      isSessionExpiredError(
        httpError(404, '{"error":{"code": -32001,"message":"gone"}}'),
      ),
    ).toBe(true)
    expect(isSessionExpiredError(httpError(404, 'Not Found'))).toBe(false)
    expect(
      isSessionExpiredError(httpError(500, '{"error":{"code":-32001}}')),
    ).toBe(false)
  })

  it('recognises a refused sign-in however it is reported', () => {
    expect(isUnauthorizedError(new UnauthorizedError())).toBe(true)
    expect(isUnauthorizedError(httpError(401, 'nope'))).toBe(true)
    expect(isUnauthorizedError(new Error('Error POSTing (HTTP 401): x'))).toBe(
      true,
    )
    expect(isUnauthorizedError(httpError(403, 'forbidden'))).toBe(false)
    expect(isUnauthorizedError(new Error('read ECONNRESET'))).toBe(false)
  })
})
