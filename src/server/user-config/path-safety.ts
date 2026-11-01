import { promises as fs } from 'fs'
import type { Stats } from 'fs'
import * as path from 'path'
import { UserConfigError } from './errors.js'

export const USER_CONFIG_ROOTS = [
  'skills',
  'agents',
  'rules',
  'commands',
] as const

export type UserConfigRoot = (typeof USER_CONFIG_ROOTS)[number]

const ROOT_SET = new Set<string>(USER_CONFIG_ROOTS)
const MAX_TREE_ENTRIES = 10_000
export const USER_CONFIG_INTERNAL_STAGE_PREFIX = '.user-config-stage-'

export function isUserConfigInternalName(name: string): boolean {
  return name.startsWith(USER_CONFIG_INTERNAL_STAGE_PREFIX)
}

export interface ParsedUserConfigPath {
  relative: string
  components: string[]
}

export interface InspectedUserConfigPath extends ParsedUserConfigPath {
  absolute: string
  exists: boolean
  stats?: Stats
}

function displayPath(relative: string): string {
  return relative || 'config root'
}

export function parseUserConfigPath(
  input: unknown,
  options: { allowRoot?: boolean } = {},
): ParsedUserConfigPath {
  if (typeof input !== 'string') {
    throw new UserConfigError(400, 'EINVAL', 'Path must be a string')
  }
  if (input.includes('\0')) {
    throw new UserConfigError(400, 'ENUL', 'Path contains a NUL byte')
  }
  if (
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    input.startsWith('~') ||
    /^[A-Za-z]:/.test(input)
  ) {
    throw new UserConfigError(
      400,
      'EABSOLUTE',
      'Absolute paths are not allowed',
    )
  }
  if (input.includes('\\')) {
    throw new UserConfigError(
      400,
      'EINVAL',
      'Backslash path separators are not allowed',
    )
  }

  const withoutTrailingSlash = input.replace(/\/+$/, '')
  if (!withoutTrailingSlash) {
    if (options.allowRoot) return { relative: '', components: [] }
    throw new UserConfigError(400, 'EINVAL', 'Path is required')
  }

  const components = withoutTrailingSlash.split('/')
  if (components.some(component => component === '..' || component === '.')) {
    throw new UserConfigError(
      400,
      'ETRAVERSAL',
      'Path traversal is not allowed',
    )
  }
  if (components.some(component => component.length === 0)) {
    throw new UserConfigError(400, 'EINVAL', 'Path contains an empty component')
  }
  if (components.some(isUserConfigInternalName)) {
    throw new UserConfigError(
      403,
      'ERESERVED',
      'Path uses a reserved internal name',
    )
  }
  if (!ROOT_SET.has(components[0]!)) {
    throw new UserConfigError(
      403,
      'EROOT',
      `Path must be under ${USER_CONFIG_ROOTS.join(', ')}`,
    )
  }
  return { relative: components.join('/'), components }
}

export function assertUserConfigName(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !input ||
    input === '.' ||
    input === '..' ||
    input.includes('/') ||
    input.includes('\\') ||
    input.includes('\0') ||
    isUserConfigInternalName(input)
  ) {
    throw new UserConfigError(
      400,
      'EINVAL',
      'Name must be one safe path segment',
    )
  }
  return input
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

export class UserConfigPathGuard {
  readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private async rootRealPath(create: boolean): Promise<string | undefined> {
    if (create) await fs.mkdir(this.root, { recursive: true })
    let stats: Stats
    try {
      stats = await fs.lstat(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (stats.isSymbolicLink()) {
      throw new UserConfigError(
        403,
        'ESYMLINK',
        'The user config root must not be a symbolic link',
      )
    }
    if (!stats.isDirectory()) {
      throw new UserConfigError(
        400,
        'ESPECIAL',
        'The user config root must be a directory',
      )
    }
    return fs.realpath(this.root)
  }

  private assertRealPath(rootReal: string, candidateReal: string): void {
    if (!isInside(rootReal, candidateReal)) {
      throw new UserConfigError(
        403,
        'EESCAPE',
        'Resolved path escapes the user config root',
      )
    }
  }

  async inspect(
    input: unknown,
    options: {
      allowRoot?: boolean
      requireExists?: boolean
      createRoot?: boolean
    } = {},
  ): Promise<InspectedUserConfigPath> {
    const parsed = parseUserConfigPath(input, {
      allowRoot: options.allowRoot,
    })
    const rootReal = await this.rootRealPath(options.createRoot ?? false)
    const absolute = path.join(this.root, ...parsed.components)

    if (!rootReal) {
      if (options.requireExists) {
        throw new UserConfigError(
          404,
          'ENOENT',
          `Not found: ${displayPath(parsed.relative)}`,
        )
      }
      return { ...parsed, absolute, exists: false }
    }
    if (parsed.components.length === 0) {
      return {
        ...parsed,
        absolute,
        exists: true,
        stats: await fs.lstat(this.root),
      }
    }

    let current = this.root
    let targetStats: Stats | undefined
    for (let index = 0; index < parsed.components.length; index += 1) {
      current = path.join(current, parsed.components[index]!)
      let stats: Stats
      try {
        stats = await fs.lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (options.requireExists) {
            throw new UserConfigError(
              404,
              'ENOENT',
              `Not found: ${displayPath(parsed.relative)}`,
            )
          }
          return { ...parsed, absolute, exists: false }
        }
        throw error
      }

      const componentPath = parsed.components.slice(0, index + 1).join('/')
      if (stats.isSymbolicLink()) {
        throw new UserConfigError(
          403,
          'ESYMLINK',
          `Symbolic links are not allowed: ${componentPath}`,
        )
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new UserConfigError(
          400,
          'ESPECIAL',
          `Special files are not allowed: ${componentPath}`,
        )
      }
      if (index < parsed.components.length - 1 && !stats.isDirectory()) {
        throw new UserConfigError(
          400,
          'ENOTDIR',
          `Path component is not a directory: ${componentPath}`,
        )
      }
      this.assertRealPath(rootReal, await fs.realpath(current))
      targetStats = stats
    }

    return { ...parsed, absolute, exists: true, stats: targetStats }
  }

  async ensureDirectory(input: unknown): Promise<InspectedUserConfigPath> {
    const parsed = parseUserConfigPath(input)
    const rootReal = await this.rootRealPath(true)
    if (!rootReal) {
      throw new UserConfigError(500, 'EINTERNAL', 'Cannot create config root')
    }

    let current = this.root
    for (let index = 0; index < parsed.components.length; index += 1) {
      current = path.join(current, parsed.components[index]!)
      try {
        await fs.mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const stats = await fs.lstat(current)
      const componentPath = parsed.components.slice(0, index + 1).join('/')
      if (stats.isSymbolicLink()) {
        throw new UserConfigError(
          403,
          'ESYMLINK',
          `Symbolic links are not allowed: ${componentPath}`,
        )
      }
      if (!stats.isDirectory()) {
        throw new UserConfigError(
          400,
          'ENOTDIR',
          `Path component is not a directory: ${componentPath}`,
        )
      }
      this.assertRealPath(rootReal, await fs.realpath(current))
    }
    return {
      ...parsed,
      absolute: path.join(this.root, ...parsed.components),
      exists: true,
      stats: await fs.lstat(current),
    }
  }

  async assertSafeTree(input: unknown): Promise<InspectedUserConfigPath> {
    const inspected = await this.inspect(input, { requireExists: true })
    if (!inspected.stats?.isDirectory()) return inspected
    const rootReal = await this.rootRealPath(false)
    if (!rootReal) {
      throw new UserConfigError(404, 'ENOENT', 'Config root not found')
    }

    let entriesSeen = 0
    const walk = async (absoluteDir: string, relativeDir: string) => {
      for (const entry of await fs.readdir(absoluteDir, {
        withFileTypes: true,
      })) {
        entriesSeen += 1
        if (entriesSeen > MAX_TREE_ENTRIES) {
          throw new UserConfigError(
            413,
            'E2BIG',
            'Directory contains too many entries',
          )
        }
        const absolute = path.join(absoluteDir, entry.name)
        const relative = `${relativeDir}/${entry.name}`
        parseUserConfigPath(relative)
        const stats = await fs.lstat(absolute)
        if (stats.isSymbolicLink()) {
          throw new UserConfigError(
            403,
            'ESYMLINK',
            `Symbolic links are not allowed: ${relative}`,
          )
        }
        if (!stats.isDirectory() && !stats.isFile()) {
          throw new UserConfigError(
            400,
            'ESPECIAL',
            `Special files are not allowed: ${relative}`,
          )
        }
        this.assertRealPath(rootReal, await fs.realpath(absolute))
        if (stats.isDirectory()) await walk(absolute, relative)
      }
    }
    await walk(inspected.absolute, inspected.relative)
    return inspected
  }
}
