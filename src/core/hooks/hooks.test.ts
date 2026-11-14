import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandHookResult } from './exec-command-hook.js'
import { createHookRunner, matchesPattern, withoutStopHooks } from './hooks.js'
import type { HooksConfig } from './types.js'

type Outcome = Partial<CommandHookResult>

const ok = (stdout = ''): Outcome => ({ status: 0, stdout })
const json = (value: unknown, status = 0): Outcome => ({
  status,
  stdout: JSON.stringify(value),
})

/** A runner whose commands answer from a table instead of being spawned. */
function runner(hooks: HooksConfig, outcomes: Record<string, Outcome> = {}) {
  const calls: Array<{
    command: string
    input: Record<string, unknown>
    cwd: string
    timeoutMs: number
    env: NodeJS.ProcessEnv
  }> = []
  const hookRunner = createHookRunner({
    hooks,
    cwd: '/repo',
    sessionId: 'session-1',
    transcriptPath: '/data/session-1.jsonl',
    getPermissionMode: () => 'agent',
    exec: async (command, jsonInput, options) => {
      calls.push({
        command,
        input: JSON.parse(jsonInput),
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
      })
      return {
        stdout: '',
        stderr: '',
        status: 0,
        timedOut: false,
        aborted: false,
        ...outcomes[command],
      }
    },
  })
  return { hookRunner, calls }
}

const command = (cmd: string, timeout?: number) => ({
  type: 'command' as const,
  command: cmd,
  ...(timeout ? { timeout } : {}),
})

const bashCall = {
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  toolUseId: 'call-1',
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe('matchesPattern', () => {
  it.each([
    ['Bash', undefined, true],
    ['Bash', '', true],
    ['Bash', '*', true],
    ['Bash', 'Bash', true],
    ['Bash', 'Edit', false],
    ['Edit', 'Edit|Write', true],
    ['Read', 'Edit|Write', false],
    // A plain name is matched whole, not as a substring.
    ['BashOutput', 'Bash', false],
    ['mcp__github__create_issue', 'mcp__github__.*', true],
    ['Write', '^(Edit|Write)$', true],
    ['Bash', '(', false],
  ])('%s against %s is %s', (toolName, matcher, expected) => {
    expect(matchesPattern(toolName, matcher)).toBe(expected)
  })
})

describe('hook runner: which commands run', () => {
  it('runs the hooks whose matcher selects the tool', async () => {
    const { hookRunner, calls } = runner({
      PreToolUse: [
        { matcher: 'Bash', hooks: [command('check-bash')] },
        { matcher: 'Edit|Write', hooks: [command('check-edit')] },
        { hooks: [command('check-all')] },
      ],
    })

    await hookRunner.preToolUse(bashCall)

    expect(calls.map(call => call.command)).toEqual(['check-bash', 'check-all'])
  })

  it('runs a command once when two settings files list it', async () => {
    const { hookRunner, calls } = runner({
      PreToolUse: [
        { matcher: 'Bash', hooks: [command('check')] },
        { matcher: '*', hooks: [command('check')] },
      ],
    })

    await hookRunner.preToolUse(bashCall)

    expect(calls).toHaveLength(1)
  })

  it('reports which events have hooks', () => {
    const { hookRunner } = runner({ Stop: [{ hooks: [command('notify')] }] })

    expect(hookRunner.has('Stop')).toBe(true)
    expect(hookRunner.has('PreToolUse')).toBe(false)
  })

  it('answers with an empty result when nothing is configured', async () => {
    const { hookRunner, calls } = runner({})

    await expect(hookRunner.preToolUse(bashCall)).resolves.toEqual({
      hookName: 'PreToolUse:Bash',
      blockingErrors: [],
      additionalContexts: [],
      outputs: [],
      preventContinuation: false,
      systemMessages: [],
    })
    expect(calls).toEqual([])
  })
})

describe('hook runner: what a command receives', () => {
  it('describes a tool call about to run', async () => {
    const { hookRunner, calls } = runner({
      PreToolUse: [{ hooks: [command('check')] }],
    })

    await hookRunner.preToolUse(bashCall)

    expect(calls[0]).toMatchObject({
      cwd: '/repo',
      input: {
        session_id: 'session-1',
        transcript_path: '/data/session-1.jsonl',
        cwd: '/repo',
        permission_mode: 'agent',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'call-1',
      },
    })
    expect(calls[0]!.env).toMatchObject({
      CLAUDE_PROJECT_DIR: '/repo',
      AGENT_PROJECT_DIR: '/repo',
    })
  })

  it('describes a tool call that finished, with its result', async () => {
    const { hookRunner, calls } = runner({
      PostToolUse: [{ hooks: [command('format')] }],
    })

    await hookRunner.postToolUse({ ...bashCall, toolResponse: 'ok' })

    expect(calls[0]!.input).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'ok',
    })
  })

  it('passes the prompt and the stop flag for the events without a tool', async () => {
    const { hookRunner, calls } = runner({
      UserPromptSubmit: [{ hooks: [command('on-prompt')] }],
      Stop: [{ hooks: [command('on-stop')] }],
    })

    await hookRunner.userPromptSubmit('fix the bug')
    await hookRunner.stop(true)

    expect(calls.map(call => call.input)).toMatchObject([
      { hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' },
      { hook_event_name: 'Stop', stop_hook_active: true },
    ])
  })

  it('uses the hook timeout in seconds, ten minutes when none is set', async () => {
    const { hookRunner, calls } = runner({
      PreToolUse: [{ hooks: [command('quick', 5), command('slow')] }],
    })

    await hookRunner.preToolUse(bashCall)

    expect(calls.map(call => call.timeoutMs)).toEqual([5_000, 600_000])
  })
})

describe('hook runner: exit codes', () => {
  it('keeps the plain output of a command that succeeds', async () => {
    const { hookRunner } = runner(
      { UserPromptSubmit: [{ hooks: [command('branch')] }] },
      { branch: ok('On branch main\n') },
    )

    const result = await hookRunner.userPromptSubmit('hello')

    expect(result.outputs).toEqual(['On branch main'])
    expect(result.blockingErrors).toEqual([])
  })

  it('blocks with stderr on exit code 2', async () => {
    const { hookRunner } = runner(
      { PreToolUse: [{ hooks: [command('guard')] }] },
      { guard: { status: 2, stderr: 'rm -rf is not allowed\n' } },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result.blockingErrors).toEqual([
      { blockingError: '[guard]: rm -rf is not allowed', command: 'guard' },
    ])
  })

  it.each([
    ['another exit code', { status: 1, stderr: 'boom' }],
    ['a timeout', { status: null, timedOut: true }],
    ['a command that cannot start', { status: null, spawnError: 'ENOENT' }],
    ['an abort', { status: null, aborted: true }],
  ] as Array<[string, Outcome]>)(
    'carries on after %s',
    async (_name, outcome) => {
      const { hookRunner } = runner(
        { PreToolUse: [{ hooks: [command('broken')] }] },
        { broken: outcome },
      )

      const result = await hookRunner.preToolUse(bashCall)

      expect(result).toMatchObject({
        blockingErrors: [],
        outputs: [],
        preventContinuation: false,
      })
      expect(result.permissionBehavior).toBeUndefined()
    },
  )
})

describe('hook runner: JSON answers', () => {
  const preToolUse = (specific: Record<string, unknown>) =>
    json({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...specific } })

  it('takes a permission decision and its reason', async () => {
    const { hookRunner } = runner(
      { PreToolUse: [{ hooks: [command('policy')] }] },
      {
        policy: preToolUse({
          permissionDecision: 'allow',
          permissionDecisionReason: 'tests are always fine',
        }),
      },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result).toMatchObject({
      permissionBehavior: 'allow',
      permissionReason: 'tests are always fine',
      blockingErrors: [],
    })
  })

  it('blocks on a deny decision', async () => {
    const { hookRunner } = runner(
      { PreToolUse: [{ hooks: [command('policy')] }] },
      {
        policy: preToolUse({
          permissionDecision: 'deny',
          permissionDecisionReason: 'no network in CI',
        }),
      },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result.permissionBehavior).toBe('deny')
    expect(result.blockingErrors).toEqual([
      { blockingError: 'no network in CI', command: 'policy' },
    ])
  })

  it('lets the strictest decision win when hooks disagree', async () => {
    const { hookRunner } = runner(
      {
        PreToolUse: [
          {
            hooks: [command('lenient'), command('strict'), command('careful')],
          },
        ],
      },
      {
        lenient: preToolUse({ permissionDecision: 'allow' }),
        strict: preToolUse({
          permissionDecision: 'deny',
          permissionDecisionReason: 'strict says no',
        }),
        careful: preToolUse({ permissionDecision: 'ask' }),
      },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result).toMatchObject({
      permissionBehavior: 'deny',
      permissionReason: 'strict says no',
    })
  })

  it('asks rather than allows when one hook wants a prompt', async () => {
    const { hookRunner } = runner(
      { PreToolUse: [{ hooks: [command('careful'), command('lenient')] }] },
      {
        careful: preToolUse({ permissionDecision: 'ask' }),
        lenient: preToolUse({ permissionDecision: 'allow' }),
      },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result.permissionBehavior).toBe('ask')
  })

  it('takes rewritten tool input and extra context', async () => {
    const { hookRunner } = runner(
      { PreToolUse: [{ hooks: [command('rewrite')] }] },
      {
        rewrite: preToolUse({
          updatedInput: { command: 'npm test -- --run' },
          additionalContext: 'Tests must not start watch mode.',
        }),
      },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result.updatedInput).toEqual({ command: 'npm test -- --run' })
    expect(result.additionalContexts).toEqual([
      'Tests must not start watch mode.',
    ])
  })

  it('treats the older approve / block decisions the same way', async () => {
    const { hookRunner } = runner(
      { PostToolUse: [{ hooks: [command('lint')] }] },
      { lint: json({ decision: 'block', reason: '2 lint errors in a.ts' }) },
    )

    const result = await hookRunner.postToolUse({
      ...bashCall,
      toolResponse: 'ok',
    })

    expect(result.blockingErrors).toEqual([
      { blockingError: '2 lint errors in a.ts', command: 'lint' },
    ])
  })

  it('stops the turn on continue: false', async () => {
    const { hookRunner } = runner(
      { Stop: [{ hooks: [command('budget')] }] },
      { budget: json({ continue: false, stopReason: 'Budget used up' }) },
    )

    const result = await hookRunner.stop(false)

    expect(result).toMatchObject({
      hookName: 'Stop',
      preventContinuation: true,
      stopReason: 'Budget used up',
    })
  })

  it('ignores an answer meant for another event', async () => {
    const { hookRunner } = runner(
      { PostToolUse: [{ hooks: [command('confused')] }] },
      { confused: preToolUse({ permissionDecision: 'deny' }) },
    )

    const result = await hookRunner.postToolUse({
      ...bashCall,
      toolResponse: 'ok',
    })

    expect(result.blockingErrors).toEqual([])
    expect(result.permissionBehavior).toBeUndefined()
  })

  it('ignores JSON that is not a hook answer', async () => {
    const { hookRunner } = runner(
      { PreToolUse: [{ hooks: [command('odd')] }] },
      { odd: json({ decision: 'maybe' }) },
    )

    const result = await hookRunner.preToolUse(bashCall)

    expect(result.blockingErrors).toEqual([])
    expect(result.outputs).toEqual([])
  })

  it('treats output that only looks like JSON as plain text', async () => {
    const { hookRunner } = runner(
      { UserPromptSubmit: [{ hooks: [command('note')] }] },
      { note: ok('{not json') },
    )

    const result = await hookRunner.userPromptSubmit('hello')

    expect(result.outputs).toEqual(['{not json'])
  })
})

describe('withoutStopHooks', () => {
  it('keeps tool hooks and drops Stop', async () => {
    const { hookRunner, calls } = runner({
      PreToolUse: [{ hooks: [command('check')] }],
      Stop: [{ hooks: [command('notify')] }],
    })
    const sub = withoutStopHooks(hookRunner)

    expect(sub.has('PreToolUse')).toBe(true)
    expect(sub.has('Stop')).toBe(false)
    await sub.preToolUse(bashCall)
    const stop = await sub.stop(false)

    expect(calls.map(call => call.command)).toEqual(['check'])
    expect(stop.blockingErrors).toEqual([])
  })
})
