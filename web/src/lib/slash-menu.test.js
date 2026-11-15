import { describe, expect, it } from 'vitest'
import { getSlashFilter, groupEntries } from './slash-menu.jsx'

describe('slash menu', () => {
  it('groups entries by where they come from, MCP prompts last', () => {
    const groups = groupEntries([
      { kind: 'mcp-prompt', name: 'mcp__git__review' },
      { kind: 'built-in', name: 'help' },
      { kind: 'built-in', name: 'commands' },
      { kind: 'command', name: 'deploy' },
      { kind: 'skill', name: 'pdf' },
      { kind: 'mcp-prompt', name: 'mcp__docs__ask' },
    ])

    expect(
      groups.map(group => [group.label, group.items.map(e => e.name)]),
    ).toEqual([
      ['Skills', ['pdf']],
      ['Commands', ['deploy']],
      ['Built-in', ['help']],
      ['MCP prompts', ['mcp__docs__ask', 'mcp__git__review']],
    ])
  })

  it('filters on what is typed after the slash', () => {
    expect(getSlashFilter('/mcp__G')).toBe('mcp__g')
    expect(getSlashFilter('/mcp__git__review the diff')).toBeNull()
    expect(getSlashFilter('hello')).toBeNull()
  })
})
