import * as fs from 'fs'
import type { IncomingMessage } from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionPlane } from '../../execution/bootstrap.js'
import type {
  EnvironmentDescriptor,
  WorkspaceHandle,
} from '../../execution/types.js'
import type { AuthedRequest } from '../auth/identity.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  resolveMarketplaceCwd,
  resolveMarketplaceTarget,
  SSH_MARKETPLACE_TARGET_DISABLED_REASON,
} from './router.js'

const previousAuth = process.env.AUTH_ENABLED
const previousCloud = process.env.CLOUD_WORKSPACES

let tempRoot: string
let workspace: string

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-cwd-'))
  workspace = path.join(tempRoot, 'project')
  fs.mkdirSync(workspace)
  process.env.AUTH_ENABLED = 'false'
  delete process.env.CLOUD_WORKSPACES
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  if (previousCloud === undefined) delete process.env.CLOUD_WORKSPACES
  else process.env.CLOUD_WORKSPACES = previousCloud
})

describe('Marketplace install scope', () => {
  it('keeps project-scoped installs on desktop', () => {
    expect(resolveMarketplaceCwd({} as IncomingMessage, workspace)).toBe(
      workspace,
    )
  })

  it('uses the user home in auth-off cloud development', () => {
    process.env.CLOUD_WORKSPACES = 'docker'

    expect(
      resolveMarketplaceCwd({} as IncomingMessage, '/workspace/repo'),
    ).toBe(os.homedir())
  })

  it('uses the request-scoped tenant home in authenticated cloud mode', () => {
    process.env.AUTH_ENABLED = 'true'
    process.env.CLOUD_WORKSPACES = 'docker'
    const agentHome = path.join(tempRoot, 'alice')

    runWithRequestScope({ agentHome, cwd: '/workspace/repo' }, () => {
      expect(
        resolveMarketplaceCwd({} as IncomingMessage, '/workspace/repo'),
      ).toBe(agentHome)
    })
  })
})

const capabilities = {
  canBrowseFs: true,
  canDeployWorker: true,
  canForwardPorts: false,
  requiresOnlineConnector: false,
  credentialMode: 'none' as const,
}

function environment(
  id: string,
  kind: EnvironmentDescriptor['kind'],
): EnvironmentDescriptor {
  return {
    id,
    kind,
    displayName: id,
    capabilities,
    endpoint: {},
  }
}

function makePlane(
  environments: EnvironmentDescriptor[],
  options: { normalizedCwd?: string; type?: 'dir' | 'file' } = {},
): Pick<ExecutionPlane, 'registry' | 'workspaces'> {
  return {
    registry: {
      listAll: vi.fn(async () => environments),
    } as unknown as ExecutionPlane['registry'],
    workspaces: {
      normalizeHandle: vi.fn(async (handle: WorkspaceHandle) => ({
        ...handle,
        cwd: options.normalizedCwd ?? handle.cwd,
      })),
      stat: vi.fn(async (_handle: WorkspaceHandle, filePath: string) => ({
        path: filePath,
        type: options.type ?? ('dir' as const),
      })),
    } as unknown as ExecutionPlane['workspaces'],
  }
}

function targetURL(query = ''): URL {
  return new URL(`/marketplaces/providers${query}`, 'http://agent.local')
}

describe('Marketplace target resolver', () => {
  it('keeps the legacy Desktop project target unchanged', async () => {
    const target = await resolveMarketplaceTarget(
      {} as IncomingMessage,
      targetURL(`?workspace=${encodeURIComponent(workspace)}`),
    )

    expect(target).toEqual({
      scope: 'workspace',
      cwd: workspace,
      legacy: true,
    })
  })

  it('resolves an explicit Desktop User target to request-scoped home', async () => {
    process.env.AUTH_ENABLED = 'true'
    const agentHome = path.join(tempRoot, 'alice')

    await runWithRequestScope({ agentHome, cwd: workspace }, async () => {
      await expect(
        resolveMarketplaceTarget(
          {} as IncomingMessage,
          targetURL('?scope=user'),
        ),
      ).resolves.toEqual({
        scope: 'user',
        cwd: agentHome,
        legacy: false,
      })
    })
  })

  it('normalizes an authorized local Workspace handle', async () => {
    const realWorkspace = path.join(tempRoot, 'real-project')
    const plane = makePlane([environment('local', 'local')], {
      normalizedCwd: realWorkspace,
    })

    const target = await resolveMarketplaceTarget(
      {} as IncomingMessage,
      targetURL(
        `?scope=workspace&environmentId=local&cwd=${encodeURIComponent(
          workspace,
        )}`,
      ),
      {
        getPlane: () => plane,
        canUseEnvironment: () => true,
      },
    )

    expect(target).toEqual({
      scope: 'workspace',
      cwd: realWorkspace,
      workspace: { environmentId: 'local', cwd: realWorkspace },
      legacy: false,
    })
  })

  it('rejects SSH Workspace targets before any remote filesystem mutation', async () => {
    const plane = makePlane([environment('ssh:build', 'ssh')])

    await expect(
      resolveMarketplaceTarget(
        {} as IncomingMessage,
        targetURL(
          '?scope=workspace&environmentId=ssh%3Abuild&cwd=%2Fsrv%2Frepo',
        ),
        {
          getPlane: () => plane,
          canUseEnvironment: () => true,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: SSH_MARKETPLACE_TARGET_DISABLED_REASON,
    })
    expect(plane.workspaces.normalizeHandle).not.toHaveBeenCalled()
  })

  it('forces every valid Cloud target contract to the tenant User home', async () => {
    process.env.AUTH_ENABLED = 'true'
    process.env.CLOUD_WORKSPACES = 'docker'
    const agentHome = path.join(tempRoot, 'cloud-user')
    const getPlane = vi.fn()
    const authorize = vi.fn()
    const queries = [
      '',
      '?scope=user',
      '?scope=workspace',
      '?scope=workspace&environmentId=cloud%3Aother&cwd=%2Fworkspace%2Frepo',
    ]

    await runWithRequestScope(
      { agentHome, cwd: '/workspace/repo' },
      async () => {
        for (const query of queries) {
          await expect(
            resolveMarketplaceTarget({} as IncomingMessage, targetURL(query), {
              getPlane,
              canUseEnvironment: authorize,
            }),
          ).resolves.toMatchObject({ scope: 'user', cwd: agentHome })
        }
      },
    )
    expect(getPlane).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('fails closed on environment authorization before resolving the handle', async () => {
    process.env.AUTH_ENABLED = 'true'
    const req = {
      user: {
        email: 'alice@example.com',
        username: 'alice',
        role: 'user',
      },
    } as AuthedRequest
    const getPlane = vi.fn(() => makePlane([environment('local', 'local')]))

    await runWithRequestScope(
      { agentHome: path.join(tempRoot, 'alice'), cwd: workspace },
      async () => {
        await expect(
          resolveMarketplaceTarget(
            req,
            targetURL(
              `?scope=workspace&environmentId=local&cwd=${encodeURIComponent(
                workspace,
              )}`,
            ),
            { getPlane },
          ),
        ).rejects.toMatchObject({
          statusCode: 404,
          message: 'Environment not found',
        })
      },
    )
    expect(getPlane).not.toHaveBeenCalled()
  })

  it('validates the environment and absolute directory cwd', async () => {
    const localPlane = makePlane([environment('local', 'local')])
    await expect(
      resolveMarketplaceTarget(
        {} as IncomingMessage,
        targetURL('?scope=workspace'),
        {
          getPlane: () => localPlane,
          canUseEnvironment: () => true,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/environmentId and cwd/),
    })
    await expect(
      resolveMarketplaceTarget(
        {} as IncomingMessage,
        targetURL(
          `?scope=workspace&environmentId=local%3Aother&cwd=${encodeURIComponent(
            workspace,
          )}`,
        ),
        {
          getPlane: () => localPlane,
          canUseEnvironment: () => true,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Environment not found',
    })
    await expect(
      resolveMarketplaceTarget(
        {} as IncomingMessage,
        targetURL('?scope=workspace&environmentId=local&cwd=relative'),
        {
          getPlane: () => localPlane,
          canUseEnvironment: () => true,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/absolute/),
    })

    const filePlane = makePlane([environment('local', 'local')], {
      type: 'file',
    })
    await expect(
      resolveMarketplaceTarget(
        {} as IncomingMessage,
        targetURL(
          `?scope=workspace&environmentId=local&cwd=${encodeURIComponent(
            workspace,
          )}`,
        ),
        {
          getPlane: () => filePlane,
          canUseEnvironment: () => true,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/directory/),
    })
  })
})
