import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import type { ExecutionPlane } from '../../execution/bootstrap.js'
import { getExecutionPlane } from '../../execution/bootstrap.js'
import { ShellFsPort } from '../../execution/shell-fs.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import { getAppDirName, getUserAppDir } from '../../utils/app-dir.js'
import { readBody, sendJSON } from '../http.js'
import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from '../routes/capabilities.js'
import { canUseEnvironment } from '../routes/execution.js'
import { EnvironmentConfigStorage } from './environment-config-storage.js'
import {
  ExtensionConfigService,
  mapExtensionConfigError,
} from './extension-config-service.js'
import { UserConfigError, userConfigErrorBody } from './errors.js'
import { LocalConfigStorage } from './local-config-storage.js'
import { MarketplaceOwnershipIndex } from './ownership.js'

type ConfigPlane = Pick<ExecutionPlane, 'registry' | 'workspaces'>

export type ExtensionConfigScope = 'user' | 'workspace'
export type ExtensionConfigTarget =
  { scope: 'user' } | { scope: 'workspace'; workspace: WorkspaceHandle }

export type ExtensionConfigRouterDeps = {
  profile?: RuntimeProfile
  getPlane?: () => ConfigPlane
  canUseEnvironment?: (req: IncomingMessage, environmentId: string) => boolean
}

type ServiceResolver = (
  req: IncomingMessage,
  url: URL,
) => Promise<ExtensionConfigService> | ExtensionConfigService

async function readJSONBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  try {
    return await readBody(req)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new UserConfigError(
      message === 'Body too large' ? 413 : 400,
      message === 'Body too large' ? 'E2BIG' : 'EINVAL',
      message === 'Body too large'
        ? 'Request body is too large'
        : 'Invalid JSON',
    )
  }
}

function userService(): ExtensionConfigService {
  return new ExtensionConfigService({
    storage: new LocalConfigStorage(getUserAppDir()),
    ownership: () => MarketplaceOwnershipIndex.load(),
  })
}

function requireWorkspaceHandle(url: URL): WorkspaceHandle {
  const environmentId = url.searchParams.get('environmentId')
  const cwd = url.searchParams.get('cwd')
  if (!environmentId || !cwd) {
    throw new UserConfigError(
      400,
      'EINVAL',
      'Workspace scope requires environmentId and cwd query parameters',
    )
  }
  return { environmentId, cwd }
}

async function workspaceService(
  req: IncomingMessage,
  url: URL,
  deps: Required<ExtensionConfigRouterDeps>,
): Promise<ExtensionConfigService> {
  // Reject by product profile before resolving or connecting any environment.
  // In particular, a Cloud request must never create repo/.ai-agent.
  if (deps.profile === 'cloud') {
    throw new UserConfigError(
      403,
      'ESCOPE',
      'Workspace extension config is unavailable in the cloud runtime profile',
    )
  }

  const handle = requireWorkspaceHandle(url)
  if (!deps.canUseEnvironment(req, handle.environmentId)) {
    throw new UserConfigError(404, 'ENOENT', 'Environment not found')
  }

  const plane = deps.getPlane()
  const descriptor = (await plane.registry.listAll()).find(
    environment => environment.id === handle.environmentId,
  )
  if (!descriptor) {
    throw new UserConfigError(404, 'ENOENT', 'Environment not found')
  }
  if (descriptor.kind !== 'local' && descriptor.kind !== 'ssh') {
    throw new UserConfigError(
      400,
      'EINVAL',
      'Workspace extension config supports local and SSH environments only',
    )
  }
  const absoluteCwd =
    descriptor.kind === 'local'
      ? path.isAbsolute(handle.cwd)
      : path.posix.isAbsolute(handle.cwd)
  if (!absoluteCwd) {
    throw new UserConfigError(
      400,
      'EABSOLUTE',
      'Workspace cwd must be an absolute path',
    )
  }

  await plane.registry.connect(descriptor)
  const port = await plane.workspaces.ensureFs(descriptor.id)
  let workspaceRoot: string
  try {
    workspaceRoot = await port.realpath(handle.cwd)
    const rootStats = await port.stat(workspaceRoot)
    if (rootStats.type !== 'dir') {
      throw new UserConfigError(
        400,
        'ENOTDIR',
        'Workspace cwd must be a directory',
      )
    }
  } catch (error) {
    if (error instanceof UserConfigError) throw error
    throw new UserConfigError(404, 'ENOENT', 'Workspace cwd was not found')
  }

  if (descriptor.kind === 'local') {
    return new ExtensionConfigService({
      storage: new LocalConfigStorage(
        path.join(workspaceRoot, getAppDirName()),
      ),
      ownership: () => MarketplaceOwnershipIndex.load(workspaceRoot),
    })
  }
  if (!(port instanceof ShellFsPort)) {
    throw new UserConfigError(
      503,
      'EUNSUPPORTED',
      'SSH filesystem does not support extension config writes',
    )
  }
  return new ExtensionConfigService({
    storage: new EnvironmentConfigStorage(port, workspaceRoot),
  })
}

function createConfigRouteAdapter(options: {
  ownsPath: (pathname: string) => boolean
  endpoint: (pathname: string) => string
  resolveService: ServiceResolver
}) {
  return async function extensionConfigRouteAdapter(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://agent.local')
    } catch {
      return false
    }
    if (!options.ownsPath(url.pathname)) return false

    try {
      const endpoint = options.endpoint(url.pathname)
      const service = await options.resolveService(req, url)

      if (req.method === 'GET' && endpoint === '') {
        sendJSON(res, 200, await service.metadata())
        return true
      }
      if (req.method === 'GET' && endpoint === '/list') {
        sendJSON(
          res,
          200,
          await service.list(url.searchParams.get('dir') ?? ''),
        )
        return true
      }
      if (req.method === 'GET' && endpoint === '/file') {
        sendJSON(res, 200, await service.read(url.searchParams.get('path')))
        return true
      }
      if (req.method === 'POST' && endpoint === '/file') {
        sendJSON(res, 200, await service.create(await readJSONBody(req)))
        return true
      }
      if (req.method === 'PUT' && endpoint === '/file') {
        sendJSON(res, 200, await service.save(await readJSONBody(req)))
        return true
      }
      if (req.method === 'POST' && endpoint === '/mkdir') {
        sendJSON(res, 200, await service.mkdir(await readJSONBody(req)))
        return true
      }
      if (req.method === 'DELETE' && endpoint === '/entry') {
        sendJSON(res, 200, await service.remove(url.searchParams.get('path')))
        return true
      }
      if (req.method === 'POST' && endpoint === '/duplicate') {
        sendJSON(res, 200, await service.duplicate(await readJSONBody(req)))
        return true
      }
      if (req.method === 'POST' && endpoint === '/upload') {
        sendJSON(res, 200, await service.upload(req, res))
        return true
      }
      if (req.method === 'GET' && endpoint === '/download') {
        await service.download(res, url.searchParams.get('path'))
        return true
      }

      throw new UserConfigError(
        404,
        'ENOTFOUND',
        'Extension config endpoint not found',
      )
    } catch (rawError) {
      const error = mapExtensionConfigError(rawError)
      if (!res.headersSent) {
        sendJSON(res, error.statusCode, userConfigErrorBody(error))
      } else {
        res.destroy()
      }
      return true
    }
  }
}

/**
 * Backward-compatible alias for authenticated user configuration.
 *
 * Request and response shapes intentionally remain byte-for-byte compatible
 * with the original `/user-config` API.
 */
export function createUserConfigRouter() {
  return createConfigRouteAdapter({
    ownsPath: pathname =>
      pathname === '/user-config' || pathname.startsWith('/user-config/'),
    endpoint: pathname => pathname.slice('/user-config'.length),
    resolveService: () => userService(),
  })
}

/**
 * Scoped extension configuration API.
 *
 * User:
 *   /extension-config/user/{list,file,mkdir,entry,duplicate,upload,download}
 * Workspace:
 *   /extension-config/workspace/... ?environmentId=<id>&cwd=<absolute path>
 *
 * Operation payloads and responses match `/user-config`; scope selection is
 * kept in the URL so JSON and multipart bodies retain the same shape.
 */
export function createExtensionConfigRouter(
  options: ExtensionConfigRouterDeps = {},
) {
  const deps: Required<ExtensionConfigRouterDeps> = {
    profile: options.profile ?? resolveRuntimeProfile(process.env),
    getPlane: options.getPlane ?? getExecutionPlane,
    canUseEnvironment: options.canUseEnvironment ?? canUseEnvironment,
  }
  return createConfigRouteAdapter({
    ownsPath: pathname =>
      pathname === '/extension-config' ||
      pathname.startsWith('/extension-config/'),
    endpoint: pathname => {
      const match = /^\/extension-config\/(user|workspace)(\/.*)?$/.exec(
        pathname,
      )
      if (!match) {
        throw new UserConfigError(
          404,
          'ENOTFOUND',
          'Extension config scope must be user or workspace',
        )
      }
      return match[2] ?? ''
    },
    resolveService: (req, url) => {
      const match = /^\/extension-config\/(user|workspace)(?:\/|$)/.exec(
        url.pathname,
      )
      if (!match) {
        throw new UserConfigError(
          404,
          'ENOTFOUND',
          'Extension config scope must be user or workspace',
        )
      }
      return match[1] === 'user'
        ? userService()
        : workspaceService(req, url, deps)
    },
  })
}
