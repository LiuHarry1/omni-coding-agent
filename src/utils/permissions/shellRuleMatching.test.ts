import { describe, expect, it } from 'vitest'
import {
  matchWildcardPattern,
  parseShellPermissionRule,
} from './shellRuleMatching.js'

describe('parseShellPermissionRule', () => {
  it('reads the three kinds of rule', () => {
    expect(parseShellPermissionRule('git status')).toEqual({
      type: 'exact',
      command: 'git status',
    })
    expect(parseShellPermissionRule('npm run:*')).toEqual({
      type: 'prefix',
      prefix: 'npm run',
    })
    expect(parseShellPermissionRule('npm run *')).toEqual({
      type: 'wildcard',
      pattern: 'npm run *',
    })
  })

  it('reads an escaped star as part of an exact command', () => {
    expect(parseShellPermissionRule('find . -name \\*.ts').type).toBe('exact')
  })
})

describe('matchWildcardPattern', () => {
  it('lets a trailing " *" match the bare command too', () => {
    expect(matchWildcardPattern('git *', 'git')).toBe(true)
    expect(matchWildcardPattern('git *', 'git add .')).toBe(true)
    expect(matchWildcardPattern('git *', 'gitk')).toBe(false)
  })

  it('matches a star in the middle', () => {
    expect(
      matchWildcardPattern('npm run * --watch', 'npm run dev --watch'),
    ).toBe(true)
    expect(matchWildcardPattern('npm run * --watch', 'npm run dev')).toBe(false)
  })

  it('treats regex characters in the pattern literally', () => {
    expect(matchWildcardPattern('echo a.b *', 'echo axb c')).toBe(false)
    expect(matchWildcardPattern('echo \\* *', 'echo * x')).toBe(true)
  })
})
