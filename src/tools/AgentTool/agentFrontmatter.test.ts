import { describe, expect, it } from 'vitest'
import type { MarkdownFile } from '../../utils/markdownConfigLoader.js'
import { parseAgentFromMarkdown } from './mergeAgents.js'

const file = (frontmatter: Record<string, unknown>): MarkdownFile =>
  ({
    filePath: '/x/agents/reviewer.md',
    source: 'project',
    frontmatter: { name: 'reviewer', description: 'Reviews', ...frontmatter },
    body: 'You review code.',
  }) as unknown as MarkdownFile

describe('agent frontmatter', () => {
  it('reads permissionMode, hooks, mcpServers, skills, background and isolation', () => {
    const { agent } = parseAgentFromMarkdown(
      file({
        permissionMode: 'plan',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }] },
          ],
          SubagentStop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }],
        },
        mcpServers: ['github', { local: { command: 'node', args: ['s.js'] } }],
        skills: ['lint', 'test'],
        background: true,
        isolation: 'worktree',
      }),
    )
    expect(agent).toMatchObject({
      permissionMode: 'plan',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }],
      },
      mcpServers: ['github', { local: { command: 'node', args: ['s.js'] } }],
      skills: ['lint', 'test'],
      background: true,
      isolation: 'worktree',
    })
  })

  it('leaves out what it does not support', () => {
    const { agent } = parseAgentFromMarkdown(
      file({
        permissionMode: 'bypassPermissions',
        isolation: 'container',
        mcpServers: [{ broken: { nope: 1 } }],
      }),
    )
    expect(agent?.permissionMode).toBeUndefined()
    expect(agent?.isolation).toBeUndefined()
    expect(agent?.mcpServers).toBeUndefined()
  })

  it('maps the Claude Code default modes to agent', () => {
    for (const mode of ['default', 'acceptEdits']) {
      expect(
        parseAgentFromMarkdown(file({ permissionMode: mode })).agent
          ?.permissionMode,
      ).toBe('agent')
    }
  })
})
