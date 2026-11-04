import { describe, expect, it, vi } from 'vitest'
import { expandSkillBody } from './expand.js'
import type { SkillDefinition } from './types.js'

describe('lazy skill runtime preparation', () => {
  it('materializes a skill package only when the body is expanded', async () => {
    const prepareRuntimeBaseDir = vi
      .fn()
      .mockResolvedValue('/workspace/.skills/chart')
    const skill: SkillDefinition = {
      name: 'chart',
      description: 'Generate charts',
      source: 'project',
      baseDir: '/control/skills/chart',
      prepareRuntimeBaseDir,
      untrustedBody: true,
      context: 'inline',
      argumentNames: [],
      loadBody: async () => 'Open ${SKILL_DIR}/template.html',
    }

    expect(prepareRuntimeBaseDir).not.toHaveBeenCalled()

    const result = await expandSkillBody(skill, '', '/workspace/repo')

    expect(prepareRuntimeBaseDir).toHaveBeenCalledOnce()
    expect(result.combined).toContain('/workspace/.skills/chart/template.html')
  })
})
