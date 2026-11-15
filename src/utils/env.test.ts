import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAuthEnabled, isEnvTruthy } from './env.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isEnvTruthy', () => {
  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('accepts %j', value => {
    expect(isEnvTruthy(value)).toBe(true)
  })

  it.each([undefined, '', '0', 'false', 'off', 'enabled'])(
    'rejects %j',
    value => {
      expect(isEnvTruthy(value)).toBe(false)
    },
  )
})

describe('isAuthEnabled', () => {
  it.each(['true', ' True '])('is on for %j', value => {
    vi.stubEnv('AUTH_ENABLED', value)
    expect(isAuthEnabled()).toBe(true)
  })

  // The deploy scripts and the web app only turn sign-in on for `true`.
  it.each(['', '1', 'yes', 'on', 'false'])('is off for %j', value => {
    vi.stubEnv('AUTH_ENABLED', value)
    expect(isAuthEnabled()).toBe(false)
  })
})
