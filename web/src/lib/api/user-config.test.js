import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExtensionConfigClient, userConfigApi } from './user-config.js'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('userConfigApi', () => {
  it('walks the list endpoint recursively for package editors', async () => {
    const responses = new Map([
      [
        '/user-config/list?dir=skills',
        {
          dir: 'skills',
          entries: [{ name: 'demo', path: 'skills/demo', isDir: true }],
        },
      ],
      [
        '/user-config/list?dir=skills%2Fdemo',
        {
          dir: 'skills/demo',
          entries: [
            {
              name: 'references',
              path: 'skills/demo/references',
              isDir: true,
            },
            {
              name: 'SKILL.md',
              path: 'skills/demo/SKILL.md',
              isDir: false,
            },
          ],
        },
      ],
      [
        '/user-config/list?dir=skills%2Fdemo%2Freferences',
        {
          dir: 'skills/demo/references',
          entries: [
            {
              name: 'guide.md',
              path: 'skills/demo/references/guide.md',
              isDir: false,
            },
          ],
        },
      ],
    ])
    const fetchMock = vi.fn(async url => jsonResponse(responses.get(url)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await userConfigApi.list('skills', { recursive: true })

    expect(result.entries.map(entry => entry.path)).toEqual([
      'skills/demo',
      'skills/demo/references',
      'skills/demo/SKILL.md',
      'skills/demo/references/guide.md',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('sends optimistic mtime saves and server-selected duplicates', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ path: 'rules/example-copy.md' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await userConfigApi.save('rules/example.md', 'updated', 42)
    await userConfigApi.duplicate('rules/example.md')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      path: 'rules/example.md',
      content: 'updated',
      mtimeMs: 42,
    })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      path: 'rules/example.md',
    })
  })

  it('targets scoped user and workspace endpoints without changing bodies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entries: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const user = createExtensionConfigClient({ scope: 'user' })
    await user.list('rules')

    const workspace = createExtensionConfigClient({
      scope: 'workspace',
      workspace: {
        environmentId: 'ssh:build-host',
        cwd: '/home/dev/repo',
      },
    })
    await workspace.read('skills/demo/SKILL.md')
    await workspace.create('rules/review.md', 'Review carefully.')

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/extension-config/user/list?dir=rules',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/extension-config/workspace/file?environmentId=ssh%3Abuild-host&cwd=%2Fhome%2Fdev%2Frepo&path=skills%2Fdemo%2FSKILL.md',
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      '/extension-config/workspace/file?environmentId=ssh%3Abuild-host&cwd=%2Fhome%2Fdev%2Frepo',
    )
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      path: 'rules/review.md',
      content: 'Review carefully.',
    })
    expect(workspace.downloadPath('rules/review.md')).toBe(
      '/extension-config/workspace/download?environmentId=ssh%3Abuild-host&cwd=%2Fhome%2Fdev%2Frepo&path=rules%2Freview.md',
    )
  })

  it('requires a complete workspace target', () => {
    expect(() =>
      createExtensionConfigClient({
        scope: 'workspace',
        workspace: { environmentId: 'local' },
      }),
    ).toThrow(/environmentId and cwd/)
  })
})
