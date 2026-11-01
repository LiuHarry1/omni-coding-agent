import { promises as fs } from 'fs'
import * as path from 'path'
import { getAppDirName } from '../../utils/app-dir.js'
import { getAgentHome } from '../../utils/request-scope.js'
import { readMarketplaceLockStrict } from '../marketplace/installer.js'
import { UserConfigError } from './errors.js'
import { parseUserConfigPath } from './path-safety.js'

export interface UserConfigOwnership {
  source: 'marketplace'
  providerId: string
  externalId: string
  kind: 'skill' | 'agent' | 'bundle'
  name: string
}

interface OwnedPath {
  path: string
  recursive: boolean
  ownership: UserConfigOwnership
}

function relativeConfigPath(installedPath: string): string | undefined {
  if (
    typeof installedPath !== 'string' ||
    installedPath.includes('\0') ||
    installedPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(installedPath)
  ) {
    return undefined
  }
  const normalized = installedPath.replace(/\\/g, '/')
  const prefix = `${getAppDirName().replace(/\\/g, '/')}/`
  if (!normalized.startsWith(prefix)) return undefined
  const relative = normalized.slice(prefix.length)
  try {
    return parseUserConfigPath(relative).relative
  } catch {
    return undefined
  }
}

export class MarketplaceOwnershipIndex {
  private constructor(private readonly paths: OwnedPath[]) {}

  static empty(): MarketplaceOwnershipIndex {
    return new MarketplaceOwnershipIndex([])
  }

  static async load(cwd = getAgentHome()): Promise<MarketplaceOwnershipIndex> {
    const marketplaceLock = path.join(
      cwd,
      getAppDirName(),
      'marketplace-lock.json',
    )
    try {
      const stats = await fs.lstat(marketplaceLock)
      if (stats.isSymbolicLink()) {
        throw new UserConfigError(
          403,
          'ESYMLINK',
          'Marketplace ownership lock must not be a symbolic link',
        )
      }
      if (!stats.isFile()) {
        throw new UserConfigError(
          400,
          'ESPECIAL',
          'Marketplace ownership lock must be a regular file',
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    let lock: Awaited<ReturnType<typeof readMarketplaceLockStrict>>
    try {
      lock = await readMarketplaceLockStrict(cwd)
    } catch {
      throw new UserConfigError(
        500,
        'EOWNERSHIP',
        'Marketplace ownership data is unavailable',
      )
    }
    const paths: OwnedPath[] = []
    for (const entry of lock.entries) {
      const ownership: UserConfigOwnership = {
        source: 'marketplace',
        providerId: entry.providerId,
        externalId: entry.externalId,
        kind: entry.kind,
        name: entry.name,
      }

      if (entry.kind === 'skill' || entry.kind === 'agent') {
        const relative = relativeConfigPath(entry.path)
        if (relative) {
          paths.push({
            path: relative,
            recursive: entry.kind === 'skill',
            ownership,
          })
        }
      }
      if (entry.kind === 'bundle') {
        for (const file of entry.files ?? []) {
          const relative = relativeConfigPath(file.path)
          if (relative) {
            paths.push({ path: relative, recursive: false, ownership })
          }
        }
      }
    }
    return new MarketplaceOwnershipIndex(paths)
  }

  private directOwner(relative: string): OwnedPath | undefined {
    return this.paths.find(
      owned =>
        relative === owned.path ||
        (owned.recursive && relative.startsWith(`${owned.path}/`)),
    )
  }

  metadata(
    relative: string,
    options: { isDirectory?: boolean } = {},
  ): { readOnly: boolean; ownership?: UserConfigOwnership } {
    const direct = this.directOwner(relative)
    if (direct) return { readOnly: true, ownership: direct.ownership }

    // A resource directory containing Marketplace files cannot be deleted as
    // a unit. Do not propagate that flag to an allowed top-level root, where
    // user-owned siblings must remain editable.
    if (options.isDirectory && relative.split('/').length > 1) {
      const descendant = this.paths.find(owned =>
        owned.path.startsWith(`${relative}/`),
      )
      if (descendant) {
        return { readOnly: true, ownership: descendant.ownership }
      }
    }
    return { readOnly: false }
  }

  assertWritable(
    relative: string,
    options: { recursiveMutation?: boolean } = {},
  ): void {
    const owned =
      this.directOwner(relative) ??
      (options.recursiveMutation
        ? this.paths.find(candidate =>
            candidate.path.startsWith(`${relative}/`),
          )
        : undefined)
    if (!owned) return
    throw new UserConfigError(
      403,
      'EOWNED',
      `Marketplace-managed path is read-only: ${relative}`,
    )
  }
}
