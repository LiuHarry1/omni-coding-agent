import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'
import {
  ShellFsError,
  ShellFsPort,
  shQuote,
  type ShellPathInfo,
} from '../../execution/shell-fs.js'
import { USER_CONFIG_GENERATION_FILE } from '../../services/user-config-generation.js'
import { getAppDirName } from '../../utils/app-dir.js'
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
} from './path-safety.js'

const MAX_TREE_ENTRIES = 10_000
const generationQueues = new Map<string, Promise<unknown>>()

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.posix.resolve(root)
  const normalizedCandidate = path.posix.resolve(candidate)
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  )
}

function relativeParent(relative: string): string {
  const parent = path.posix.dirname(relative)
  return parent === '.' ? '' : parent
}

function missingEntry(relative: string): ConfigStorageInspection {
  return {
    path: relative,
    name: relative ? path.posix.basename(relative) : '',
    isDir: false,
    size: 0,
    mtimeMs: 0,
    exists: false,
  }
}

function toEntry(
  relative: string,
  info: ShellPathInfo,
): ConfigStorageInspection {
  return {
    path: relative,
    name: relative ? path.posix.basename(relative) : '',
    isDir: info.type === 'dir',
    size: info.size,
    mtimeMs: info.mtimeMs,
    mode: info.mode,
    exists: info.type !== 'missing',
  }
}

function assertRegularType(info: ShellPathInfo, relative: string): void {
  if (info.type === 'symlink') {
    throw new UserConfigError(
      403,
      'ESYMLINK',
      `Symbolic links are not allowed: ${relative || 'config root'}`,
    )
  }
  if (info.type !== 'missing' && info.type !== 'dir' && info.type !== 'file') {
    throw new UserConfigError(
      400,
      'ESPECIAL',
      `Special files are not allowed: ${relative || 'config root'}`,
    )
  }
}

async function inspectLocalTree(localPath: string): Promise<{
  isDir: boolean
  size: number
  entries: Array<{
    absolute: string
    relative: string
    isDir: boolean
    mode: number
  }>
}> {
  const root = await fs.lstat(localPath)
  if (root.isSymbolicLink()) {
    throw new UserConfigError(
      403,
      'ESYMLINK',
      'Staged path must not be a symbolic link',
    )
  }
  if (!root.isDirectory() && !root.isFile()) {
    throw new UserConfigError(
      400,
      'ESPECIAL',
      'Staged path must be a regular file or directory',
    )
  }
  const entries: Array<{
    absolute: string
    relative: string
    isDir: boolean
    mode: number
  }> = []
  let seen = 0
  let size = root.isFile() ? root.size : 0
  const walk = async (absoluteDir: string, relativeDir: string) => {
    for (const child of await fs.readdir(absoluteDir, {
      withFileTypes: true,
    })) {
      seen += 1
      if (seen > MAX_TREE_ENTRIES) {
        throw new UserConfigError(
          413,
          'E2BIG',
          'Directory contains too many entries',
        )
      }
      if (
        child.name.includes('/') ||
        child.name.includes('\\') ||
        child.name === '.' ||
        child.name === '..'
      ) {
        throw new UserConfigError(
          400,
          'EINVAL',
          'Staged tree contains an unsafe filename',
        )
      }
      const absolute = path.join(absoluteDir, child.name)
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name
      const stats = await fs.lstat(absolute)
      if (stats.isSymbolicLink()) {
        throw new UserConfigError(
          403,
          'ESYMLINK',
          `Staged tree contains a symbolic link: ${relative}`,
        )
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new UserConfigError(
          400,
          'ESPECIAL',
          `Staged tree contains a special file: ${relative}`,
        )
      }
      entries.push({
        absolute,
        relative,
        isDir: stats.isDirectory(),
        mode: stats.mode & 0o777,
      })
      if (stats.isDirectory()) await walk(absolute, relative)
      else size += stats.size
    }
  }
  if (root.isDirectory()) await walk(localPath, '')
  return { isDir: root.isDirectory(), size, entries }
}

export class EnvironmentConfigStorage implements ConfigStoragePort {
  readonly displayName: string
  readonly root: string

  constructor(
    private readonly port: ShellFsPort,
    readonly workspaceRoot: string,
    appDirName = getAppDirName(),
  ) {
    this.workspaceRoot = path.posix.resolve(workspaceRoot)
    this.displayName = appDirName
    this.root = path.posix.join(this.workspaceRoot, appDirName)
  }

  private absolute(relative: string): string {
    return relative
      ? path.posix.join(this.root, ...relative.split('/'))
      : this.root
  }

  private async inspectRoot(create: boolean): Promise<ShellPathInfo> {
    let info = await this.port.inspectPath(this.root)
    assertRegularType(info, '')
    if (info.type === 'missing' && create) {
      const workspace = await this.port.inspectPath(this.workspaceRoot)
      assertRegularType(workspace, 'workspace')
      if (workspace.type !== 'dir') {
        throw new UserConfigError(
          404,
          'ENOENT',
          'Workspace directory was not found',
        )
      }
      await this.port.mkdir(this.root)
      info = await this.port.inspectPath(this.root)
      assertRegularType(info, '')
    }
    if (info.type !== 'missing' && info.type !== 'dir') {
      throw new UserConfigError(
        400,
        'ESPECIAL',
        'The extension config root must be a directory',
      )
    }
    if (info.type === 'dir') {
      const real = await this.port.realpath(this.root)
      if (!isInside(this.workspaceRoot, real)) {
        throw new UserConfigError(
          403,
          'EESCAPE',
          'Resolved path escapes the workspace',
        )
      }
    }
    return info
  }

  async initialize(): Promise<void> {
    await this.inspectRoot(false)
  }

  async inspect(
    relative: string,
    options: {
      allowRoot?: boolean
      requireExists?: boolean
      createRoot?: boolean
    } = {},
  ): Promise<ConfigStorageInspection> {
    const parsed = parseUserConfigPath(relative, {
      allowRoot: options.allowRoot,
    })
    const root = await this.inspectRoot(options.createRoot ?? false)
    if (root.type === 'missing') {
      if (options.requireExists) {
        throw new UserConfigError(
          404,
          'ENOENT',
          `Not found: ${parsed.relative || 'config root'}`,
        )
      }
      return missingEntry(parsed.relative)
    }
    if (parsed.components.length === 0) return toEntry('', root)

    let current = this.root
    let target: ShellPathInfo | undefined
    for (let index = 0; index < parsed.components.length; index += 1) {
      current = path.posix.join(current, parsed.components[index]!)
      const relativeComponent = parsed.components.slice(0, index + 1).join('/')
      const info = await this.port.inspectPath(current)
      assertRegularType(info, relativeComponent)
      if (info.type === 'missing') {
        if (options.requireExists) {
          throw new UserConfigError(
            404,
            'ENOENT',
            `Not found: ${parsed.relative}`,
          )
        }
        return missingEntry(parsed.relative)
      }
      if (index < parsed.components.length - 1 && info.type !== 'dir') {
        throw new UserConfigError(
          400,
          'ENOTDIR',
          `Path component is not a directory: ${relativeComponent}`,
        )
      }
      const real = await this.port.realpath(current)
      if (!isInside(this.root, real)) {
        throw new UserConfigError(
          403,
          'EESCAPE',
          `Resolved path escapes the config root: ${relativeComponent}`,
        )
      }
      target = info
    }
    return toEntry(parsed.relative, target!)
  }

  async list(relative: string): Promise<ConfigStorageEntry[]> {
    const directory = await this.inspect(relative, {
      allowRoot: relative === '',
      requireExists: true,
    })
    if (!directory.isDir) {
      throw new UserConfigError(400, 'ENOTDIR', `Not a directory: ${relative}`)
    }
    const children = await this.port.list(this.absolute(relative))
    const entries = await Promise.all(
      children
        .filter(child => !isUserConfigInternalName(child.name))
        .map(async child => {
          const childRelative = parseUserConfigPath(
            relative ? `${relative}/${child.name}` : child.name,
          ).relative
          return this.inspect(childRelative, { requireExists: true })
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
    const inspected = await this.inspect(relative, { requireExists: true })
    if (inspected.isDir) {
      throw new UserConfigError(400, 'EISDIR', 'Path is not a regular file')
    }
    const buffer = await this.port.readHead(
      this.absolute(relative),
      Math.min(inspected.size, maxBytes),
    )
    const after = await this.inspect(relative, { requireExists: true })
    if (
      after.isDir ||
      after.size !== inspected.size ||
      Math.abs(after.mtimeMs - inspected.mtimeMs) > 1
    ) {
      throw new UserConfigError(
        409,
        'ESTALE',
        `File changed while it was read: ${relative}`,
      )
    }
    return {
      buffer,
      size: inspected.size,
      mtimeMs: inspected.mtimeMs,
      mode: inspected.mode,
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
    const target = await this.inspect(relative, {
      requireExists: !options.createOnly,
      createRoot: true,
    })
    if (options.createOnly && target.exists) {
      throw new UserConfigError(409, 'EEXIST', `Already exists: ${relative}`)
    }
    if (!options.createOnly && target.isDir) {
      throw new UserConfigError(400, 'EISDIR', 'Path is not a regular file')
    }
    const parent = await this.inspect(relativeParent(relative), {
      allowRoot: relativeParent(relative) === '',
      requireExists: true,
    })
    if (!parent.isDir) {
      throw new UserConfigError(400, 'ENOTDIR', 'Parent is not a directory')
    }
    await this.port.writeFileAtomic(this.absolute(relative), data, {
      createOnly: options.createOnly,
      requireExisting: !options.createOnly,
      expectedMtimeMs: options.expectedMtimeMs,
      mode: options.mode ?? target.mode,
    })
    return this.inspect(relative, { requireExists: true })
  }

  async ensureDirectory(relative: string): Promise<ConfigStorageEntry> {
    const parsed = parseUserConfigPath(relative)
    await this.inspectRoot(true)
    let current = ''
    for (const component of parsed.components) {
      current = current ? `${current}/${component}` : component
      const inspected = await this.inspect(current)
      if (!inspected.exists) await this.port.mkdir(this.absolute(current))
      const verified = await this.inspect(current, { requireExists: true })
      if (!verified.isDir) {
        throw new UserConfigError(
          400,
          'ENOTDIR',
          `Path component is not a directory: ${current}`,
        )
      }
    }
    return this.inspect(parsed.relative, { requireExists: true })
  }

  private async assertSafeTree(relative: string): Promise<ConfigStorageEntry> {
    const target = await this.inspect(relative, { requireExists: true })
    if (!target.isDir) return target
    let seen = 0
    const walk = async (directory: string) => {
      for (const child of await this.list(directory)) {
        seen += 1
        if (seen > MAX_TREE_ENTRIES) {
          throw new UserConfigError(
            413,
            'E2BIG',
            'Directory contains too many entries',
          )
        }
        if (child.isDir) await walk(child.path)
      }
    }
    await walk(relative)
    return target
  }

  async remove(relative: string): Promise<void> {
    await this.assertSafeTree(relative)
    await this.port.remove(this.absolute(relative))
  }

  async exportEntry(
    relative: string,
    destinationDir: string,
  ): Promise<ConfigStorageExport> {
    const source = await this.assertSafeTree(relative)
    const destination = path.join(destinationDir, path.posix.basename(relative))
    let totalSize = 0
    const copy = async (
      sourceRelative: string,
      localDestination: string,
    ): Promise<void> => {
      const entry = await this.inspect(sourceRelative, { requireExists: true })
      if (entry.isDir) {
        await fs.mkdir(localDestination, {
          recursive: false,
          mode: entry.mode || 0o700,
        })
        for (const child of await this.list(sourceRelative)) {
          await copy(child.path, path.join(localDestination, child.name))
        }
        return
      }
      const before = entry
      const bytes = Buffer.from(await this.port.read(this.absolute(entry.path)))
      const after = await this.inspect(entry.path, { requireExists: true })
      if (
        after.isDir ||
        after.size !== before.size ||
        Math.abs(after.mtimeMs - before.mtimeMs) > 1
      ) {
        throw new UserConfigError(
          409,
          'ESTALE',
          `File changed while it was copied: ${entry.path}`,
        )
      }
      totalSize += bytes.length
      await fs.writeFile(localDestination, bytes, {
        mode: entry.mode || 0o600,
        flag: 'wx',
      })
    }
    await copy(relative, destination)
    return {
      localPath: destination,
      isDir: source.isDir,
      size: totalSize,
    }
  }

  async publishEntry(
    localPath: string,
    relative: string,
  ): Promise<ConfigStorageEntry> {
    const parsed = parseUserConfigPath(relative)
    const target = await this.inspect(parsed.relative, { createRoot: true })
    if (target.exists) {
      throw new UserConfigError(
        409,
        'EEXIST',
        `Destination already exists: ${parsed.relative}`,
      )
    }
    const parentRelative = relativeParent(parsed.relative)
    const parent = await this.inspect(parentRelative, {
      allowRoot: parentRelative === '',
      requireExists: true,
    })
    if (!parent.isDir) {
      throw new UserConfigError(400, 'ENOTDIR', 'Parent is not a directory')
    }

    const source = await inspectLocalTree(localPath)
    const stageRelative = parentRelative
      ? `${parentRelative}/${USER_CONFIG_INTERNAL_STAGE_PREFIX}${crypto.randomUUID()}`
      : `${USER_CONFIG_INTERNAL_STAGE_PREFIX}${crypto.randomUUID()}`
    const stageAbsolute = this.absolute(stageRelative)
    try {
      if (source.isDir) {
        await this.port.mkdir(stageAbsolute)
        for (const entry of source.entries.filter(entry => entry.isDir)) {
          await this.port.mkdir(path.posix.join(stageAbsolute, entry.relative))
        }
        for (const entry of source.entries.filter(entry => !entry.isDir)) {
          await this.port.writeFileAtomic(
            path.posix.join(stageAbsolute, entry.relative),
            await fs.readFile(entry.absolute),
            { createOnly: true, mode: entry.mode },
          )
        }
      } else {
        await this.port.writeFileAtomic(
          stageAbsolute,
          await fs.readFile(localPath),
          { createOnly: true },
        )
      }

      const destinationAbsolute = this.absolute(parsed.relative)
      const result = await this.port.run(`
s=${shQuote(stageAbsolute)}
d=${shQuote(destinationAbsolute)}
[ -L "$s" ] && { echo ERR:ESYMLINK; exit 3; }
[ -e "$s" ] || { echo ERR:ENOENT; exit 3; }
[ ! -e "$d" ] && [ ! -L "$d" ] || { echo ERR:EEXIST; exit 3; }
mv "$s" "$d"
`)
      if (result.code !== 0) {
        const reported = /^ERR:([A-Z]+)/.exec(
          result.stdout.toString('utf8'),
        )?.[1]
        if (reported === 'EEXIST') {
          throw new UserConfigError(
            409,
            'EEXIST',
            `Destination already exists: ${parsed.relative}`,
          )
        }
        if (reported === 'ESYMLINK') {
          throw new UserConfigError(
            403,
            'ESYMLINK',
            'Staged path must not be a symbolic link',
          )
        }
        throw new ShellFsError(
          reported === 'ENOENT' ? 'ENOENT' : 'EIO',
          result.stderr.trim() || 'Could not publish config entry',
        )
      }
    } finally {
      await this.port.remove(stageAbsolute).catch(() => {})
    }
    return this.inspect(parsed.relative, { requireExists: true })
  }

  async getGeneration(): Promise<number> {
    const root = await this.inspectRoot(false)
    if (root.type === 'missing') return 0
    const generationPath = path.posix.join(
      this.root,
      USER_CONFIG_GENERATION_FILE,
    )
    const info = await this.port.inspectPath(generationPath)
    assertRegularType(info, USER_CONFIG_GENERATION_FILE)
    if (info.type === 'missing') return 0
    if (info.type !== 'file') {
      throw new UserConfigError(
        400,
        'ESPECIAL',
        'Config generation path must be a regular file',
      )
    }
    const raw = String(
      await this.port.read(generationPath, { encoding: 'utf8' }),
    )
    const value = /^\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : 0
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  bumpGeneration(): Promise<number> {
    const key = `${this.workspaceRoot}\0${this.root}`
    const previous = generationQueues.get(key) ?? Promise.resolve()
    const run = previous.then(
      () => this.bumpGenerationUnlocked(),
      () => this.bumpGenerationUnlocked(),
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    generationQueues.set(key, settled)
    return run.finally(() => {
      if (generationQueues.get(key) === settled) generationQueues.delete(key)
    })
  }

  private async bumpGenerationUnlocked(): Promise<number> {
    await this.inspectRoot(true)
    const current = await this.getGeneration()
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new UserConfigError(
        500,
        'EINTERNAL',
        'Config generation counter is exhausted',
      )
    }
    const next = current + 1
    const generationPath = path.posix.join(
      this.root,
      USER_CONFIG_GENERATION_FILE,
    )
    const info = await this.port.inspectPath(generationPath)
    assertRegularType(info, USER_CONFIG_GENERATION_FILE)
    await this.port.writeFileAtomic(
      generationPath,
      Buffer.from(`${next}\n`, 'utf8'),
      {
        createOnly: info.type === 'missing',
        requireExisting: info.type !== 'missing',
        mode: 0o600,
      },
    )
    return next
  }
}
