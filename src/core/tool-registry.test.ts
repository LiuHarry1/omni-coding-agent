import { describe, expect, it } from 'vitest'

import { EventBus } from './event-bus.js'
import { ToolRegistry } from './tool-registry.js'
import type { ToolContext, ToolDefinition } from './types.js'
import { noopWireEmitter } from './wire-emitter.js'
import { registerSkills } from '../skills/index.js'
import type { SkillDefinition } from '../skills/types.js'

function skill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} skill`,
    source: 'user',
    context: 'inline',
    argumentNames: [],
    loadBody: async () => `${name} body`,
  }
}

function context(): ToolContext {
  return {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
  } as ToolContext
}

describe('ToolRegistry fork', () => {
  it('snapshots base definitions without sharing later mutations', () => {
    const base = new ToolRegistry()
    const builtin = {
      name: 'Builtin',
      description: 'base tool',
      create: () => ({}) as never,
    } satisfies ToolDefinition
    base.register(builtin)

    const fork = base.fork()
    fork.register({ ...builtin, name: 'TurnOnly' })

    expect(fork.get('Builtin')).toBe(builtin)
    expect(fork.get('TurnOnly')).toBeDefined()
    expect(base.get('TurnOnly')).toBeUndefined()
  })

  it('isolates concurrent users and leaves the next turn skill-free', async () => {
    const base = new ToolRegistry()
    const alice = base.fork()
    const bob = base.fork()

    await Promise.all([
      registerSkills(alice, '/alice', [], {
        preloadedSkills: [skill('alice-only')],
      }),
      registerSkills(bob, '/bob', [], {
        preloadedSkills: [skill('bob-only')],
      }),
    ])

    const aliceTool = alice.get('Skill')!.create('/workspace/repo', context())
    const bobTool = bob.get('Skill')!.create('/workspace/repo', context())
    const executeAlice = (
      aliceTool as unknown as {
        execute: (input: { skill: string }) => Promise<unknown>
      }
    ).execute
    const executeBob = (
      bobTool as unknown as {
        execute: (input: { skill: string }) => Promise<unknown>
      }
    ).execute

    await expect(executeAlice({ skill: 'bob-only' })).resolves.toBe(
      'Unknown skill: bob-only',
    )
    await expect(executeBob({ skill: 'alice-only' })).resolves.toBe(
      'Unknown skill: alice-only',
    )
    expect(base.get('Skill')).toBeUndefined()
    expect(base.fork().get('Skill')).toBeUndefined()
  })
})
