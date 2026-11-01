import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setCORS } from './http.js'

const previous = {
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  BAIZE_ALLOW_ANY_ORIGIN: process.env.BAIZE_ALLOW_ANY_ORIGIN,
}

function headersFor(origin: string, host = '127.0.0.1:4567') {
  const headers = new Map<string, string>()
  const response = {
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value)
    },
  } as unknown as ServerResponse
  const request = {
    headers: { origin, host },
  } as IncomingMessage
  setCORS(response, request)
  return headers
}

describe('CORS defaults', () => {
  beforeEach(() => {
    delete process.env.AUTH_ENABLED
    delete process.env.ALLOWED_ORIGINS
    delete process.env.BAIZE_ALLOW_ANY_ORIGIN
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('allows loopback development origins but not arbitrary websites', () => {
    expect(
      headersFor('http://localhost:8090').get('access-control-allow-origin'),
    ).toBe('http://localhost:8090')
    expect(
      headersFor('https://untrusted.example').has(
        'access-control-allow-origin',
      ),
    ).toBe(false)
  })

  it('requires same-origin or an explicit allowlist when auth is enabled', () => {
    process.env.AUTH_ENABLED = 'true'
    expect(
      headersFor('https://agent.example', 'agent.example').get(
        'access-control-allow-origin',
      ),
    ).toBe('https://agent.example')
    expect(
      headersFor('https://app.example', 'agent.example').has(
        'access-control-allow-origin',
      ),
    ).toBe(false)

    process.env.ALLOWED_ORIGINS = 'https://app.example'
    expect(
      headersFor('https://app.example', 'agent.example').get(
        'access-control-allow-origin',
      ),
    ).toBe('https://app.example')
  })

  it('supports an explicit wide-open development override', () => {
    process.env.BAIZE_ALLOW_ANY_ORIGIN = 'true'
    expect(
      headersFor('https://any.example').get('access-control-allow-origin'),
    ).toBe('*')
  })
})
