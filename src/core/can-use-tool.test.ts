import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { definition as bashToolDefinition } from '../tools/BashTool/BashTool.js'
import {
  createFilesystemPermissionContext,
  type FilesystemPermissionMode,
} from '../utils/permissions/filesystem.js'
import { answerPermission } from './brokers/permission-broker.js'
import { createCanUseTool } from './can-use-tool.js'
import type { ToolDefinition } from './types.js'
import { WireEmitter } from './wire-emitter.js'

type ControlRequest = {
  type: string
  request_id: string
  request: { subtype: string; command?: string; always_rules?: string[] }
}

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function gate(
  options: {
    mode?: FilesystemPermissionMode
    interactive?: boolean
    allow?: string[]
    ask?: string[]
    deny?: string[]
  } = {},
) {
  const prompts: ControlRequest[] = []
  const permissionContext = createFilesystemPermissionContext(root, {
    mode: options.mode ?? 'default',
    allow: options.allow,
    ask: options.ask,
    deny: options.deny,
  })
  const definitions: Record<string, ToolDefinition> = {
    Bash: bashToolDefinition,
  }
  const canUseTool = createCanUseTool({
    cwd: root,
    getDefinition: name => definitions[name],
    permissionContext,
    wire: new WireEmitter(
      { emit: message => prompts.push(message as ControlRequest) },
      'test-session',
    ),
    interactive: options.interactive,
  })
  const run = (
    command: string,
    toolUseId = 'call-1',
    hookPermission?: { behavior: 'allow' | 'ask'; reason?: string },
  ) => canUseTool('Bash', { command }, { toolUseId, hookPermission })
  return { run, prompts, permissionContext, canUseTool }
}

/** Resolves once the gate has put a prompt on the wire. */
async function prompted(prompts: ControlRequest[]): Promise<ControlRequest> {
  for (let i = 0; i < 50 && prompts.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const prompt = prompts[0]
  if (!prompt) throw new Error('the gate did not ask')
  return prompt
}

function localSettings(): { permissions?: { allow?: string[] } } {
  const file = path.join(root, '.ai-agent', 'settings.local.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

describe('createCanUseTool: shell commands', () => {
  it('runs a read-only command without asking', async () => {
    const { run, prompts } = gate()

    await expect(run('git status')).resolves.toEqual({ behavior: 'allow' })
    expect(prompts).toEqual([])
  })

  it('asks before a command no rule mentions, and runs it on Allow', async () => {
    const { run, prompts, permissionContext } = gate()

    const decision = run('npm run build')
    const prompt = await prompted(prompts)
    expect(prompt.request).toMatchObject({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      command: 'npm run build',
      always_rules: ['Bash(npm run:*)'],
    })
    answerPermission(prompt.request_id, { behavior: 'allow' })

    await expect(decision).resolves.toEqual({ behavior: 'allow' })
    expect(permissionContext.allow).toEqual([])
    expect(localSettings()).toEqual({})
  })

  it('remembers the rule on Always allow, for this turn and later ones', async () => {
    const { run, prompts } = gate()

    const first = run('npm run build')
    const prompt = await prompted(prompts)
    answerPermission(prompt.request_id, { behavior: 'always' })
    await expect(first).resolves.toEqual({ behavior: 'allow' })

    await expect(run('npm run lint', 'call-2')).resolves.toEqual({
      behavior: 'allow',
    })
    expect(prompts).toHaveLength(1)
    expect(localSettings().permissions?.allow).toEqual(['Bash(npm run:*)'])
  })

  it('tells the model when the user rejects the command', async () => {
    const { run, prompts } = gate()

    const decision = run('npm run build')
    const prompt = await prompted(prompts)
    answerPermission(prompt.request_id, { behavior: 'deny' })

    await expect(decision).resolves.toEqual({
      behavior: 'deny',
      message: 'User rejected Bash command npm run build.',
    })
  })

  it('refuses a denied command without asking', async () => {
    const { run, prompts } = gate({ deny: ['Bash(rm -rf:*)'] })

    await expect(run('rm -rf build')).resolves.toEqual({
      behavior: 'deny',
      message:
        'Permission to use Bash with command rm -rf build has been denied.',
    })
    expect(prompts).toEqual([])
  })

  it('still asks for a command under an ask rule when permissions are bypassed', async () => {
    const { run, prompts } = gate({
      mode: 'bypassPermissions',
      ask: ['Bash(git push:*)'],
    })

    await expect(run('npm run build')).resolves.toEqual({ behavior: 'allow' })
    const decision = run('git push origin main', 'call-2')
    const prompt = await prompted(prompts)
    expect(prompt.request.always_rules).toEqual([])
    answerPermission(prompt.request_id, { behavior: 'allow' })
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
  })

  describe.each([
    ['in dontAsk mode', { mode: 'dontAsk' as const }],
    ['in a scheduled turn', { interactive: false }],
  ])('%s, where nobody can be asked', (_where, options) => {
    it('runs a command no rule mentions', async () => {
      const { run, prompts } = gate(options)

      await expect(run('npm run build')).resolves.toEqual({
        behavior: 'allow',
      })
      expect(prompts).toEqual([])
    })

    it('refuses a command under an ask rule', async () => {
      const { run, prompts } = gate({ ...options, ask: ['Bash(git push:*)'] })

      await expect(run('git push origin main')).resolves.toEqual({
        behavior: 'deny',
        message:
          'Bash needs approval to run git push origin main, and nobody can be asked in this session.',
      })
      expect(prompts).toEqual([])
    })

    it('refuses a denied command', async () => {
      const { run } = gate({ ...options, deny: ['Bash(rm -rf:*)'] })

      await expect(run('rm -rf build')).resolves.toMatchObject({
        behavior: 'deny',
      })
    })
  })
})

describe('createCanUseTool: a PreToolUse hook decision', () => {
  const hookAllows = { behavior: 'allow' as const, reason: 'tests are fine' }
  const hookAsks = { behavior: 'ask' as const, reason: 'Touches production' }

  it('runs a command the hook allowed without asking', async () => {
    const { run, prompts } = gate()

    await expect(run('npm run build', 'call-1', hookAllows)).resolves.toEqual({
      behavior: 'allow',
    })
    expect(prompts).toEqual([])
  })

  it('still refuses a denied command the hook allowed', async () => {
    const { run } = gate({ deny: ['Bash(rm -rf:*)'] })

    await expect(
      run('rm -rf build', 'call-1', hookAllows),
    ).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('still asks for a command under an ask rule the hook allowed', async () => {
    const { run, prompts } = gate({ ask: ['Bash(git push:*)'] })

    const decision = run('git push origin main', 'call-1', hookAllows)
    const prompt = await prompted(prompts)
    answerPermission(prompt.request_id, { behavior: 'allow' })

    await expect(decision).resolves.toEqual({ behavior: 'allow' })
  })

  it('asks before a read-only command when the hook wants a prompt', async () => {
    const { run, prompts, permissionContext } = gate()

    const decision = run('git status', 'call-1', hookAsks)
    const prompt = await prompted(prompts)
    expect(prompt.request).toMatchObject({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      description: 'Touches production',
      command: 'Bash: git status',
      // Nothing to remember: the hook decides each time.
      always_rules: [],
    })
    answerPermission(prompt.request_id, { behavior: 'always' })

    await expect(decision).resolves.toEqual({ behavior: 'allow' })
    expect(permissionContext.allow).toEqual([])
    expect(localSettings()).toEqual({})
  })

  it('asks for a tool without a permission check of its own', async () => {
    const { canUseTool, prompts } = gate()

    const decision = canUseTool(
      'WebFetch',
      { url: 'https://example.test' },
      { toolUseId: 'call-1', hookPermission: { behavior: 'ask' } },
    )
    const prompt = await prompted(prompts)
    expect(prompt.request).toMatchObject({
      description: 'A hook asked for confirmation before WebFetch runs.',
      command: 'WebFetch: https://example.test',
    })
    answerPermission(prompt.request_id, { behavior: 'deny' })

    await expect(decision).resolves.toEqual({
      behavior: 'deny',
      message: 'User rejected WebFetch: https://example.test.',
    })
  })

  it('refuses when the hook wants a prompt and nobody can be asked', async () => {
    const { run, prompts } = gate({ interactive: false })

    await expect(run('git status', 'call-1', hookAsks)).resolves.toEqual({
      behavior: 'deny',
      message:
        'A hook requires approval for Bash: git status, and nobody can be asked in this session.',
    })
    expect(prompts).toEqual([])
  })
})
