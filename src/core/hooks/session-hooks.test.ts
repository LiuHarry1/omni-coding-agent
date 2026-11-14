import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookRunner } from './hooks.js'
import { createSessionHookRunner, submitUserPrompt } from './session-hooks.js'
import type { HooksConfig } from './types.js'

const hooks: HooksConfig = {
  Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
}
const base = { cwd: '/repo', sessionId: 'session-1', remote: false }
const previousAuth = process.env.AUTH_ENABLED

beforeEach(() => {
  delete process.env.AUTH_ENABLED
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
})

describe('createSessionHookRunner', () => {
  it('runs the configured hooks for a local workspace', () => {
    const runner = createSessionHookRunner({ ...base, hooks })

    expect(runner?.has('Stop')).toBe(true)
  })

  it.each([
    ['no hooks setting', undefined],
    ['an empty hooks setting', {}],
    ['events without hooks', { Stop: [] }],
  ] as Array<[string, HooksConfig | undefined]>)(
    'is absent with %s',
    (_name, config) => {
      expect(
        createSessionHookRunner({ ...base, hooks: config }),
      ).toBeUndefined()
    },
  )

  it('does not run hooks for a remote workspace', () => {
    expect(
      createSessionHookRunner({ ...base, hooks, remote: true }),
    ).toBeUndefined()
  })

  it('does not run hooks on a shared server with sign-in', () => {
    process.env.AUTH_ENABLED = 'true'

    expect(createSessionHookRunner({ ...base, hooks })).toBeUndefined()
  })
})

describe('submitUserPrompt', () => {
  /** Hooks whose one UserPromptSubmit command prints `stdout`. */
  const promptHooks = (outcome: {
    stdout?: string
    stderr?: string
    status?: number
  }) => {
    const prompts: string[] = []
    const runner = createHookRunner({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'on-prompt' }] },
        ],
      },
      cwd: '/repo',
      sessionId: 'session-1',
      exec: async (_command, jsonInput) => {
        prompts.push(JSON.parse(jsonInput).prompt)
        return {
          stdout: '',
          stderr: '',
          status: 0,
          timedOut: false,
          aborted: false,
          ...outcome,
        }
      },
    })
    return { runner, prompts }
  }

  it('adds nothing when the hook is silent', async () => {
    const { runner, prompts } = promptHooks({})

    await expect(submitUserPrompt(runner, 'fix the bug')).resolves.toBe(
      undefined,
    )
    expect(prompts).toEqual(['fix the bug'])
  })

  it('adds what the hook printed to the context', async () => {
    const { runner } = promptHooks({ stdout: 'On branch release-2\n' })

    await expect(
      submitUserPrompt(runner, 'fix the bug'),
    ).resolves.toMatchObject([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'UserPromptSubmit',
          content: 'On branch release-2',
        },
      },
    ])
  })

  it('adds the context a hook returned as JSON', async () => {
    const { runner } = promptHooks({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'Ticket: OPS-12',
        },
      }),
    })

    await expect(
      submitUserPrompt(runner, 'fix the bug'),
    ).resolves.toMatchObject([
      {
        attachment: {
          type: 'hook_additional_context',
          content: ['Ticket: OPS-12'],
        },
      },
    ])
  })

  it('refuses the prompt when a hook blocks it', async () => {
    const { runner } = promptHooks({ status: 2, stderr: 'contains a secret\n' })

    await expect(submitUserPrompt(runner, 'key=abc')).rejects.toThrow(
      'UserPromptSubmit operation blocked by hook:\n[on-prompt]: contains a secret',
    )
  })

  it('stops with the reason when a hook says not to continue', async () => {
    const { runner } = promptHooks({
      stdout: JSON.stringify({ continue: false, stopReason: 'Office closed' }),
    })

    await expect(submitUserPrompt(runner, 'hello')).rejects.toThrow(
      'Operation stopped by hook: Office closed',
    )
  })

  it('does nothing without UserPromptSubmit hooks', async () => {
    const runner = createHookRunner({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
      cwd: '/repo',
      sessionId: 'session-1',
      exec: async () => {
        throw new Error('no command should run')
      },
    })

    await expect(submitUserPrompt(runner, 'hello')).resolves.toBe(undefined)
  })
})
