import * as os from 'os'
import { describe, expect, it } from 'vitest'
import { execCommandHook } from './exec-command-hook.js'

const options = { cwd: os.tmpdir(), timeoutMs: 10_000, env: process.env }

describe.skipIf(process.platform === 'win32')('execCommandHook', () => {
  it('gives the command the event JSON on stdin and returns its output', async () => {
    const result = await execCommandHook('cat', '{"tool_name":"Bash"}', options)

    expect(result).toMatchObject({
      stdout: '{"tool_name":"Bash"}',
      status: 0,
      timedOut: false,
      aborted: false,
    })
  })

  it('reports the exit code and stderr of a command that fails', async () => {
    const result = await execCommandHook(
      'echo "not allowed" >&2; exit 2',
      '{}',
      options,
    )

    expect(result).toMatchObject({ status: 2, stderr: 'not allowed\n' })
  })

  it('runs in the given directory with the given environment', async () => {
    const result = await execCommandHook('echo "$PWD|$HOOK_TEST_VALUE"', '{}', {
      ...options,
      cwd: '/',
      env: { ...process.env, HOOK_TEST_VALUE: 'from-env' },
    })

    expect(result.stdout).toBe('/|from-env\n')
  })

  it('does not fail when the command never reads stdin', async () => {
    const result = await execCommandHook('true', 'x'.repeat(200_000), options)

    expect(result.status).toBe(0)
  })

  it('stops a command that runs past its timeout', async () => {
    const started = Date.now()
    const result = await execCommandHook('sleep 30', '{}', {
      ...options,
      timeoutMs: 50,
    })

    expect(result.timedOut).toBe(true)
    expect(result.status).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('stops a command when the turn is aborted', async () => {
    const controller = new AbortController()
    const pending = execCommandHook('sleep 30', '{}', {
      ...options,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)

    const result = await pending

    expect(result.aborted).toBe(true)
  })

  it('does not start a command when the turn is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await execCommandHook('echo ran', '{}', {
      ...options,
      signal: controller.signal,
    })

    expect(result).toMatchObject({ aborted: true, stdout: '' })
  })
})
