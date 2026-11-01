import { describe, expect, it } from 'vitest'
import {
  normalizeConfigTree,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  slugifyResourceName,
  topLevelResources,
  updateMarkdownBody,
  updateMarkdownFrontmatterField,
} from './extensions-model.js'
import {
  MASKED_SECRET,
  isAllowedMcpConfig,
  maskMcpHeaders,
  maskMcpUrl,
  normalizeMcpTransports,
  normalizeMcpResponse,
} from './mcp-model.js'
import {
  isMtimeConflict,
  normalizeUserConfigPath,
} from '../../lib/api/user-config.js'

describe('extensions resource model', () => {
  it('normalizes nested trees and keeps managed resources read-only', () => {
    const entries = normalizeConfigTree(
      {
        tree: {
          children: [
            {
              name: 'pdf',
              path: 'skills/pdf',
              type: 'directory',
              source: 'marketplace',
              children: [
                {
                  name: 'SKILL.md',
                  path: 'skills/pdf/SKILL.md',
                  type: 'file',
                },
              ],
            },
            {
              name: 'notes',
              path: 'skills/notes',
              type: 'directory',
            },
          ],
        },
      },
      'skills',
    )

    const skills = topLevelResources(entries, 'skills', { folders: true })
    expect(skills.map(skill => skill.name)).toEqual(['notes', 'pdf'])
    expect(skills.find(skill => skill.name === 'pdf')?.readOnly).toBe(true)
    expect(entries.some(entry => entry.path === 'skills/pdf/SKILL.md')).toBe(
      true,
    )
  })

  it('updates one frontmatter field without dropping nested YAML', () => {
    const source = `---
name: reviewer
description: |
  Reviews difficult changes.
tools:
  - Read
  - Grep
mode: subagent
---
Original body
`
    const updated = updateMarkdownFrontmatterField(source, 'mode', 'primary')
    const parsed = parseMarkdownDocument(source)

    expect(parsed.frontmatter.description).toBe('Reviews difficult changes.\n')
    expect(parsed.frontmatter.tools).toEqual(['Read', 'Grep'])
    expect(updated).toContain('description: |')
    expect(updated).toContain('  - Read')
    expect(updated).toContain('mode: primary')
    expect(updated).toContain('Original body')
  })

  it('edits Markdown bodies while preserving raw frontmatter', () => {
    const source = '---\npaths: [src/**, test/**]\n---\nOld'
    const updated = updateMarkdownBody(source, 'New')
    expect(updated).toBe('---\npaths: [src/**, test/**]\n---\nNew')
    expect(parseMarkdownDocument(updated).body).toBe('New')
  })

  it('round-trips simple frontmatter used for new resources', () => {
    const source = serializeMarkdownDocument(
      {
        name: 'release-notes',
        context: 'inline',
        paths: ['src/**', 'docs/**'],
      },
      '# Instructions\n',
    )
    const parsed = parseMarkdownDocument(source)
    expect(parsed.frontmatter).toEqual({
      name: 'release-notes',
      context: 'inline',
      paths: ['src/**', 'docs/**'],
    })
    expect(slugifyResourceName(' Release Notes! ')).toBe('release-notes')
  })

  it('round-trips quotes, backslashes, Unicode, arrays, comments, and key order', () => {
    const source = `---
# Keep this operator note.
name: reviewer
description: 'Review "C:\\work\\代码" without rewriting it'
paths:
  - src/**
  - "docs/研发/**"
unknown:
  enabled: true
context: inline
---
Instructions
`

    let updated = source
    for (const value of ['fork', 'inline', 'fork']) {
      updated = updateMarkdownFrontmatterField(updated, 'context', value)
    }

    const parsed = parseMarkdownDocument(updated)
    expect(parsed.parseError).toBeNull()
    expect(parsed.frontmatter.description).toBe(
      'Review "C:\\work\\代码" without rewriting it',
    )
    expect(parsed.frontmatter.paths).toEqual(['src/**', 'docs/研发/**'])
    expect(parsed.frontmatter.unknown).toEqual({ enabled: true })
    expect(updated).toContain('# Keep this operator note.')
    expect(updated.indexOf('name:')).toBeLessThan(updated.indexOf('paths:'))
    expect(updated.indexOf('paths:')).toBeLessThan(updated.indexOf('unknown:'))
    expect(updated).toContain('Instructions')
  })
})

describe('MCP presentation model', () => {
  it('retains header names without retaining saved secret values', () => {
    const response = {
      effectiveMcpServers: {
        docs: {
          transport: 'http',
          url: 'https://mcp.example.com?apiKey=url-secret',
          headers: {
            Authorization: 'Bearer extremely-secret',
            'X-Tenant': 'acme',
          },
        },
      },
      mcpStatus: [{ name: 'docs', status: 'connected', tools: ['search'] }],
    }

    const [server] = normalizeMcpResponse(response)
    expect(server.headerNames).toEqual(['Authorization', 'X-Tenant'])
    expect(JSON.stringify(server)).not.toContain('extremely-secret')
    expect(server.url).not.toContain('url-secret')
    expect(maskMcpUrl('https://mcp.example.com?token=secret')).toContain(
      encodeURIComponent(MASKED_SECRET),
    )
    expect(maskMcpHeaders(response.effectiveMcpServers.docs.headers)).toEqual({
      Authorization: MASKED_SECRET,
      'X-Tenant': MASKED_SECRET,
    })
  })

  it('restores transport and masked header names from safe status metadata', () => {
    const [server] = normalizeMcpResponse({
      servers: [
        { name: 'docs', status: 'connected', tools: ['search', 'open'] },
      ],
      configs: {
        docs: {
          transport: 'http',
          url: `https://mcp.example.com?token=${encodeURIComponent(MASKED_SECRET)}`,
          headerNames: ['Authorization'],
        },
      },
    })

    expect(server).toMatchObject({
      name: 'docs',
      status: 'connected',
      transport: 'http',
      headerNames: ['Authorization'],
      tools: ['search', 'open'],
    })
  })

  it('keeps MCP ownership and writable scope from safe metadata', () => {
    const servers = normalizeMcpResponse({
      servers: [{ name: 'policy', status: 'connected', tools: [] }],
      configs: {
        policy: {
          transport: 'http',
          url: 'https://policy.example/mcp',
          configuredBy: 'managed',
          writable: false,
        },
      },
    })

    expect(servers[0]).toMatchObject({
      configuredBy: 'managed',
      writable: false,
      writableScope: null,
    })
  })

  it('validates only manifest-permitted transport forms', () => {
    expect(normalizeMcpTransports(['http', 'invalid', 'sse', 'http'])).toEqual([
      'http',
      'sse',
    ])
    expect(
      isAllowedMcpConfig({ transport: 'stdio', command: 'npx' }, [
        'stdio',
        'http',
        'sse',
      ]),
    ).toBe(true)
    expect(
      isAllowedMcpConfig({ transport: 'stdio', command: 'npx' }, [
        'http',
        'sse',
      ]),
    ).toBe(false)
    expect(
      isAllowedMcpConfig(
        { transport: 'http', url: 'https://mcp.example.com' },
        ['http', 'sse'],
      ),
    ).toBe(true)
  })
})

describe('user config client helpers', () => {
  it('normalizes relative API paths and identifies mtime conflicts', () => {
    expect(normalizeUserConfigPath('/skills\\pdf/')).toBe('skills/pdf')
    expect(isMtimeConflict({ status: 409 })).toBe(true)
    expect(isMtimeConflict({ status: 400 })).toBe(false)
  })
})
