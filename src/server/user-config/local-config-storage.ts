import * as crypto from 'crypto'
import * as fsSync from 'fs'
import { promises as fs } from 'fs'
import * as path from 'path'
import {
  bumpUserConfigGeneration,
  getUserConfigGeneration,
} from '../../services/user-config-generation.js'
import { UserConfigError } from './errors.js'
import type {
  ConfigStorageEntry,
  ConfigStorageExport,
  ConfigStorageInspection,
  ConfigStoragePort,
  ConfigStorageReadResult,
} from './config-storage.js'
import {
  isUserConfigInternalName,
  parseUserConfigPath,
  USER_CONFIG_INTERNAL_STAGE_PREFIX,
  UserConfigPathGuard,
} from './path-safety.js'

const MAX_TREE_ENTRIES = 10_000

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function nameFor(relative: string): string {
  return relative ? path.posix.basename(relative) : ''
}

function missingEntry(relative: string): ConfigStorageInspection {
  return {
    path: relative,
    name: nameFor(relative),
    isDir: false,
    size: 0,
    mtimeMs: 0,
    exists: false,
  }
}

function toEntry(
  relative: string,
  stats: fsSync.Stats,
): ConfigStorageInspection {
  return {
    path: relative,
    name: nameFor(relative),
    isDir: stats.isDirectory(),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode & 0o777,
    exists: true,
  }
}

async function atomicWrite(
  target: string,
  data: Buffer,
  options: {
    createOnly: boolean
    expectedMtimeMs?: number
    mode?: number
    relative: string
  },
): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temp, 'wx', options.mode ?? 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined

    if (options.createOnly) {
      await fs.link(temp, target)
      await fs.unlink(temp)
      return
    }

    const current = await fs.lstat(target)
    if (current.isSymbolicLink()) {
      throw new UserConfigError(
        403,
        'ESYMLINK',
        `Symbolic links are not allowed: ${options.relative}`,
      )
    }
    if (!current.isFile()) {
      throw new UserConfigError(
        400,
        'ESPECIAL',
        `Path is not a regular file: ${options.relative}`,
      )
    }
    if (
      options.expectedMtimeMs !== undefined &&
      Math.abs(current.mtimeMs - options.expectedMtimeMs) > 1
    ) {
      throw new UserConfigError(
        409,
        'EMTIME',
        `File modified externally: ${options.relative}`,
      )
    }
    await fs.rename(temp, target)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

async function copyRegularFileNoFollow(
  source: string,
  destination: string,
): Promise<void> {
  const before = await fs.lstat(source)
  if (before.isSymbolicLink()) {
    throw new UserConfigError(
      403,
      'ESYMLINK',
      'Source must not be a symbolic link',
    )
  }
  if (!before.isFile()) {
    throw new UserConfigError(400, 'ESPECIAL', 'Source must be a regular file')
  }

  let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    sourceHandle = await fs.open(
      source,
      fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0),
    )
    const opened = await sourceHandle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new UserConfigError(
        409,
        'ESTALE',
        'Source changed while it was opened',
      )
    }

    destinationHandle = await fs.open(destination, 'wx', opened.mode & 0o777)
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        buffer.length,
        position,
      )
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        )
        written += result.bytesWritten
      }
      position += bytesRead
    }
    const after = await sourceHandle.stat()
    if (
      after.size !== opened.size ||
      Math.abs(after.mtimeMs - opened.mtimeMs) > 1
    ) {
      throw new UserConfigError(
        409,
        'ESTALE',
        'Source changed while it was copied',
      )
    }
    await destinationHandle.sync()
  } finally {
    await destinationHandle?.close().catch(() => {})
    await sourceHandle?.close().catch(() => {})
  }
}

async function assertSafeLocalTree(
  tree: string,
  allowedRoot: string,
): Promise<{ isDir: boolean; size: number }> {
  const resolvedAllowedRoot = path.resolve(allowedRoot)
  const resolvedTree = path.resolve(tree)
  if (!isInside(resolvedAllowedRoot, resolvedTree)) {
    throw new UserConfigError(403, 'EESCAPE', 'Staged path escapes its root')
  }
  const rootReal = await fs.realpath(resolvedAllowedRoot)
  const stats = await fs.lstat(resolvedTree)
  if (stats.isSymbolicLink()) {
    throw new UserConfigError(
      403,
      'ESYMLINK',
      'Staged path must not be a symbolic link',
    )
  }
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new UserConfigError(
      400,
      'ESPECIAL',
      'Staged path must be a regular file or directory',
    )
  }
  const treeReal = await fs.realpath(resolvedTree)
  if (!isInside(rootReal, treeReal)) {
    throw new UserConfigError(
      403,
      'EESCAPE',
      'Staged path resolves outside its root',
    )
  }

  let entriesSeen = 0
  let totalSize = stats.isFile() ? stats.size : 0
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
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (
        entry.name.includes('\\') ||
        entry.name === '.' ||
        entry.name === '..'
      ) {
        throw new UserConfigError(
          400,
          'EINVAL',
          `Staged tree contains an unsafe name: ${relative}`,
        )
      }
      const absolute = path.join(absoluteDir, entry.name)
      const child = await fs.lstat(absolute)
      if (child.isSymbolicLink()) {
        throw new UserConfigError(
          403,
          'ESYMLINK',
          `Staged tree contains a symbolic link: ${relative}`,
        )
      }
      if (!child.isDirectory() && !child.isFile()) {
        throw new UserConfigError(
          400,
          'ESPECIAL',
          `Staged tree contains a special file: ${relative}`,
        )
      }
      const real = await fs.realpath(absolute)
      if (!isInside(treeReal, real)) {
        throw new UserConfigError(
          403,
          'EESCAPE',
          `Staged entry resolves outside the tree: ${relative}`,
        )
      }
      if (child.isDirectory()) await walk(absolute, relative)
      else totalSize += child.size
    }
  }
  if (stats.isDirectory()) await walk(resolvedTree, '')
  return { isDir: stats.isDirectory(), size: totalSize }
}

export class LocalConfigStorage implements ConfigStoragePort {
  readonly displayName: string
  private readonly guard: UserConfigPathGuard

  constructor(
    readonly root: string,
    options: { displayName?: string } = {},
  ) {
    this.root = path.resolve(root)
    this.displayName = options.displayName ?? path.basename(this.root)
    this.guard = new UserConfigPathGuard(this.root)
  }

  async initialize(): Promise<void> {
    await this.guard.inspect('', { allowRoot: true })
  }

  async inspect(
    relative: string,
    options: {
      allowRoot?: boolean
      requireExists?: boolean
      createRoot?: boolean
    } = {},
  ): Promise<ConfigStorageInspection> {
    const inspected = await this.guard.inspect(relative, options)
    return inspected.exists && inspected.stats
      ? toEntry(inspected.relative, inspected.stats)
      : missingEntry(inspected.relative)
  }

  async list(relative: string): Promise<ConfigStorageEntry[]> {
    const inspected = await this.guard.inspect(relative, {
      allowRoot: relative === '',
      requireExists: true,
    })
    if (!inspected.stats?.isDirectory()) {
      throw new UserConfigError(
        400,
        'ENOTDIR',
        `Not a directory: ${inspected.relative}`,
      )
    }
    const entries = await Promise.all(
      (
        await fs.readdir(inspected.absolute, {
          withFileTypes: true,
        })
      )
        .filter(entry => !isUserConfigInternalName(entry.name))
        .map(async entry => {
          const child = parseUserConfigPath(
            `${inspected.relative}/${entry.name}`,
          )
          const childInspected = await this.guard.inspect(child.relative, {
            requireExists: true,
          })
          return toEntry(child.relative, childInspected.stats!)
        }),
    )
    entries.sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return entries
  }

  async readFile(
    relative: string,
    maxBytes: number,
  ): Promise<ConfigStorageReadResult> {
    const inspected = await this.guard.inspect(relative, {
      requireExists: true,
    })
    if (!inspected.stats?.isFile()) {
      throw new UserConfigError(400, 'EISDIR', 'Path is not a regular file')
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(
        inspected.absolute,
        fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0),
      )
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw new UserConfigError(400, 'EISDIR', 'Path is not a regular file')
      }
      const length = Math.min(stats.size, maxBytes)
      const buffer = Buffer.alloc(length)
      if (length > 0) await handle.read(buffer, 0, length, 0)
      return {
        buffer,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        mode: stats.mode & 0o777,
      }
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async writeFile(
    relative: string,
    data: Buffer,
    options: {
      createOnly: boolean
      expectedMtimeMs?: number
      mode?: number
    },
  ): Promise<ConfigStorageEntry> {
    const target = await this.guard.inspect(relative, {
      requireExists: !options.createOnly,
      createRoot: true,
    })
    if (options.createOnly && target.exists) {
      throw new UserConfigError(
        409,
        'EEXIST',
        `Already exists: ${target.relative}`,
      )
    }
    if (!options.createOnly && !target.stats?.isFile()) {
      throw new UserConfigError(400, 'EISDIR', 'Path is not a regular file')
    }
    const parentRelative = path.posix.dirname(target.relative)
    const parent = await this.guard.inspect(
      parentRelative === '.' ? '' : parentRelative,
      { allowRoot: parentRelative === '.', requireExists: true },
    )
    if (!parent.stats?.isDirectory()) {
      throw new UserConfigError(400, 'ENOTDIR', 'Parent is not a directory')
    }
    await atomicWrite(target.absolute, data, {
      ...options,
      mode: options.mode ?? target.stats?.mode,
      relative: target.relative,
    })
    const stats = await fs.lstat(target.absolute)
    return toEntry(target.relative, stats)
  }

  async ensureDirectory(relative: string): Promise<ConfigStorageEntry> {
    const created = await this.guard.ensureDirectory(relative)
    return toEntry(created.relative, created.stats!)
  }

  async remove(relative: string): Promise<void> {
    const target = await this.guard.assertSafeTree(relative)
    await fs.rm(target.absolute, {
      recursive: target.stats?.isDirectory() ?? false,
      force: false,
    })
  }

  async exportEntry(
    relative: string,
    destinationDir: string,
  ): Promise<ConfigStorageExport> {
    const source = await this.guard.assertSafeTree(relative)
    const destination = path.join(
      destinationDir,
      path.basename(source.absolute),
    )
    if (source.stats?.isDirectory()) {
      await fs.cp(source.absolute, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      })
    } else {
      await copyRegularFileNoFollow(source.absolute, destination)
    }
    const validated = await assertSafeLocalTree(destination, destinationDir)
    return {
      localPath: destination,
      isDir: validated.isDir,
      size: validated.size,
    }
  }

  async publishEntry(
    localPath: string,
    relative: string,
  ): Promise<ConfigStorageEntry> {
    const parsed = parseUserConfigPath(relative)
    const target = await this.guard.inspect(parsed.relative, {
      createRoot: true,
    })
    if (target.exists) {
      throw new UserConfigError(
        409,
        'EEXIST',
        `Destination already exists: ${target.relative}`,
      )
    }
    const parentRelative = path.posix.dirname(target.relative)
    const parent = await this.guard.inspect(
      parentRelative === '.' ? '' : parentRelative,
      { allowRoot: parentRelative === '.', requireExists: true },
    )
    if (!parent.stats?.isDirectory()) {
      throw new UserConfigError(400, 'ENOTDIR', 'Parent is not a directory')
    }

    const source = await assertSafeLocalTree(localPath, path.dirname(localPath))
    const stage = path.join(
      path.dirname(target.absolute),
      `${USER_CONFIG_INTERNAL_STAGE_PREFIX}${crypto.randomUUID()}`,
    )
    try {
      if (source.isDir) {
        await fs.cp(localPath, stage, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
          verbatimSymlinks: true,
        })
      } else {
        await copyRegularFileNoFollow(localPath, stage)
      }
      await assertSafeLocalTree(stage, this.root)
      if (source.isDir) {
        try {
          await fs.lstat(target.absolute)
          throw new UserConfigError(
            409,
            'EEXIST',
            `Destination already exists: ${target.relative}`,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await fs.rename(stage, target.absolute)
      } else {
        await fs.link(stage, target.absolute)
        await fs.unlink(stage)
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
    }
    const stats = await fs.lstat(target.absolute)
    return toEntry(target.relative, stats)
  }

  getGeneration(): Promise<number> {
    return getUserConfigGeneration(this.root)
  }

  bumpGeneration(): Promise<number> {
    return bumpUserConfigGeneration(this.root)
  }
}
