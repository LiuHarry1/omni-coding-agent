import { describe, expect, it } from 'vitest'
import { expandSkillBody } from './expand.js'
import type { SkillDefinition } from './types.js'

describe('skill base directory', () => {
  it('expands SKILL_DIR to the skill baseDir', async () => {
    const skill: SkillDefinition = {
      name: 'chart',
      description: 'Generate charts',
      source: 'user',
      baseDir: '/workspace/users/alice/.ai-agent/skills/chart',
      untrustedBody: true,
      context: 'inline',
      argumentNames: [],
      loadBody: async () => 'Open ${SKILL_DIR}/template.html',
    }

    const result = await expandSkillBody(skill, '', '/workspace/repo')

    expect(result.preamble).toContain(
      'Base directory for this skill: /workspace/users/alice/.ai-agent/skills/chart',
    )
    expect(result.combined).toContain(
      '/workspace/users/alice/.ai-agent/skills/chart/template.html',
    )
  })
})
