import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../core/event-bus.js'
import type { ToolContext } from '../core/types.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { expandSkillBody } from '../skills/expand.js'
import type { SkillDefinition } from '../skills/types.js'
import { createSkillTool } from '../tools/SkillTool/SkillTool.js'
import { dispatchSlashCommand } from './dispatcher.js'

function backend(): ExecutionBackend {
  return {
    kind: 'worker',
    environmentId: 'cloud:abcdef0123456789',
    resolve: vi.fn((cwd, filePath) => path.posix.resolve(cwd, filePath)),
    assertInWorkspace: vi.fn(),
    readText: vi.fn(async () => 'container file'),
    readBytes: vi.fn(),
    writeText: vi.fn(),
    mkdirp: vi.fn(),
    exists: vi.fn(),
    isDirectory: vi.fn(),
    exec: vi.fn(async () => ({
      stdout: 'shared-container\n',
      stderr: '',
      code: 0,
    })),
    rg: vi.fn(),
  }
}

describe('turn directive backend sharing', () => {
  it('uses the same backend for slash dispatch and SkillTool expansion', async () => {
    const execution = backend()
    const slash = await dispatchSlashCommand(
      '/remote',
      {
        cwd: '/workspace/repo',
        directiveRuntime: execution,
      },
      {
        entries: [
          {
            kind: 'command',
            name: 'remote',
            description: 'remote command',
            def: {
              name: 'remote',
              description: 'remote command',
              source: 'user',
              argumentNames: [],
              body: 'Slash !`pwd`',
            },
          },
        ],
      },
    )
    expect(slash).toMatchObject({
      kind: 'run',
      text: 'Slash shared-container',
    })

    const skill: SkillDefinition = {
      name: 'remote-skill',
      description: 'remote skill',
      source: 'user',
      context: 'inline',
      argumentNames: [],
      loadBody: async () => 'Skill !`pwd`',
    }
    const created = createSkillTool([skill], []).create('/workspace/repo', {
      eventBus: new EventBus(),
      wire: noopWireEmitter,
      execution,
    } as unknown as ToolContext) as unknown as {
      execute: (input: { skill: string }) => Promise<{
        newMessages: Array<{ content: string }>
      }>
    }
    const result = await created.execute({ skill: 'remote-skill' })

    expect(result.newMessages[0]?.content).toContain('Skill shared-container')
    expect(execution.exec).toHaveBeenCalledTimes(2)
  })

  it('expands a mapped SKILL_DIR before backend command execution', async () => {
    const execution = backend()
    const skill: SkillDefinition = {
      name: 'mapped-skill',
      description: 'mapped cloud skill',
      source: 'user',
      context: 'inline',
      argumentNames: [],
      baseDir: '/host/.ai-agent/skills/mapped-skill',
      runtimeBaseDir:
        '/tmp/baize-extension-session-ws/snapshot/skills/mapped-skill',
      loadBody: async () => '!`${SKILL_DIR}/scripts/x.sh`',
    }

    await expandSkillBody(skill, '', '/workspace/repo', execution)

    expect(execution.exec).toHaveBeenCalledWith(
      '/tmp/baize-extension-session-ws/snapshot/skills/mapped-skill/scripts/x.sh',
      {
        cwd: '/workspace/repo',
        timeoutMs: 15_000,
      },
    )
  })

  it('does not execute directives introduced by skill arguments', async () => {
    const execution = backend()
    const skill: SkillDefinition = {
      name: 'safe-arguments',
      description: 'safe arguments',
      source: 'user',
      context: 'inline',
      argumentNames: [],
      loadBody: async () => 'User request: $ARGUMENTS',
    }

    const result = await expandSkillBody(
      skill,
      '!`touch /tmp/injected` @secrets.txt',
      '/workspace/repo',
      execution,
    )

    expect(result.combined).toContain('!`touch /tmp/injected` @secrets.txt')
    expect(execution.exec).not.toHaveBeenCalled()
    expect(execution.readText).not.toHaveBeenCalled()
  })

  it('quotes arguments inside authored shell directives', async () => {
    const execution = backend()
    const skill: SkillDefinition = {
      name: 'quoted-shell',
      description: 'quoted shell',
      source: 'user',
      context: 'inline',
      argumentNames: [],
      loadBody: async () => 'Result: !`printf %s $ARGUMENTS`',
    }

    await expandSkillBody(
      skill,
      'hello; touch /tmp/not-a-command',
      '/workspace/repo',
      execution,
    )

    expect(execution.exec).toHaveBeenCalledWith(
      "printf %s 'hello;' 'touch' '/tmp/not-a-command'",
      {
        cwd: '/workspace/repo',
        timeoutMs: 15_000,
      },
    )
  })

  it('treats an argument in an authored file directive as one literal path', async () => {
    const execution = backend()
    const skill: SkillDefinition = {
      name: 'literal-file',
      description: 'literal file',
      source: 'user',
      context: 'inline',
      argumentNames: [],
      loadBody: async () => 'Read @docs/$0',
    }

    await expandSkillBody(
      skill,
      '"hello world.md"',
      '/workspace/repo',
      execution,
    )

    expect(execution.resolve).toHaveBeenCalledWith(
      '/workspace/repo',
      'docs/hello world.md',
    )
    expect(execution.readText).toHaveBeenCalledWith(
      '/workspace/repo/docs/hello world.md',
    )
  })
})
