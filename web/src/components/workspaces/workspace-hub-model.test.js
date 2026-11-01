import { describe, expect, it } from 'vitest'
import {
  buildCloudWorkspaceItems,
  buildDesktopWorkspaceItems,
  isWorkspaceProfileLocked,
  resolveWorkspaceCreateMethods,
  workspaceHandleId,
} from './workspace-hub-model.js'

describe('workspace hub capability profile', () => {
  it('renders only create methods declared by the workspace capability', () => {
    expect(
      resolveWorkspaceCreateMethods({
        workspace: {
          enabled: true,
          createMethods: ['clone', 'blank'],
        },
      }).map(method => method.id),
    ).toEqual(['clone', 'blank'])
    expect(
      resolveWorkspaceCreateMethods({
        workspace: {
          enabled: true,
          createMethods: ['clone'],
        },
      })[0],
    ).toMatchObject({
      label: 'Clone repository',
      description: expect.stringContaining('HTTPS Git repository'),
    })

    expect(
      resolveWorkspaceCreateMethods({
        workspace: {
          enabled: true,
          createMethods: ['local-folder', 'ssh'],
        },
      }).map(method => method.id),
    ).toEqual(['local-folder', 'ssh'])

    expect(
      resolveWorkspaceCreateMethods({
        workspace: {
          enabled: false,
          createMethods: ['clone'],
        },
      }),
    ).toEqual([])
  })

  it('locks managed desktop folders without blocking normal cloud users', () => {
    expect(isWorkspaceProfileLocked('desktop', true, false)).toBe(true)
    expect(isWorkspaceProfileLocked('cloud', true, false)).toBe(false)
    expect(isWorkspaceProfileLocked('desktop', true, true)).toBe(false)
  })
})

describe('desktop workspace handles', () => {
  it('keeps current and recent local/SSH handles without cloud records', () => {
    const current = { environmentId: 'ssh:dev', cwd: '/srv/current' }
    const items = buildDesktopWorkspaceItems({
      handle: current,
      label: 'Dev:/srv/current',
      recentHandles: [
        {
          environmentId: 'ssh:dev',
          cwd: '/srv/current',
          label: 'Duplicate',
          lastUsedAt: 3,
        },
        {
          environmentId: 'local',
          cwd: '/Users/me/project',
          label: '/Users/me/project',
          lastUsedAt: 2,
        },
        {
          environmentId: 'cloud:one',
          cwd: '/workspace/repo',
          label: 'Cloud',
          lastUsedAt: 4,
        },
      ],
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: workspaceHandleId(current),
      current: true,
      kind: 'ssh',
      name: 'Dev:/srv/current',
    })
    expect(items[1]).toMatchObject({
      current: false,
      kind: 'local',
      name: 'project',
    })
  })
})

describe('cloud workspace records', () => {
  it('prioritizes the current workspace and preserves lifecycle status', () => {
    const items = buildCloudWorkspaceItems(
      [
        {
          id: 'pending',
          name: 'Pending',
          status: 'provisioning',
          source: { kind: 'empty' },
        },
        {
          id: 'current',
          name: 'Current',
          status: 'ready',
          source: {
            kind: 'git',
            url: 'https://github.com/acme/project.git',
            ref: 'main',
          },
        },
      ],
      'current',
      'pending',
    )

    expect(items.map(item => item.id)).toEqual(['current', 'pending'])
    expect(items[0]).toMatchObject({
      current: true,
      pending: false,
      sourceDisplay: {
        label: 'Git · github.com/acme/project',
        detail: 'Branch or tag: main',
      },
    })
    expect(items[1]).toMatchObject({
      current: false,
      pending: true,
      sourceDisplay: {
        label: 'Cloud · Blank workspace',
      },
    })
  })
})
