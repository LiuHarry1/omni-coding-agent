import * as crypto from 'crypto'
import * as fsSync from 'fs'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import matter from 'gray-matter'
import * as archiverPkg from 'archiver'
import { ShellFsError } from '../../execution/shell-fs.js'
import {
  extractAndValidateSkillZip,
  SKILL_PACKAGE_LIMITS,
} from '../marketplace/installer.js'
import { MarketplaceError } from '../marketplace/http.js'
import {
  contentDisposition,
  mimeTypeFor,
  receiveUpload,
} from '../workspace/transfer.js'
import type { ConfigStorageEntry, ConfigStoragePort } from './config-storage.js'
import { UserConfigError } from './errors.js'
import { MarketplaceOwnershipIndex } from './ownership.js'
import {
  assertUserConfigName,
  parseUserConfigPath,
  USER_CONFIG_ROOTS,
} from './path-safety.js'

export const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_CONFIG_WRITE_BYTES = 5 * 1024 * 1024
export const MAX_CONFIG_UPLOAD_BYTES = 5 * 1024 * 1024

type ZipArchiveInstance = import('stream').PassThrough & {
  on(event: 'error', listener: (error: Error) => void): ZipArchiveInstance
  pipe(destination: ServerResponse): ZipArchiveInstance
  file(
    filePath: string,
    options: { name: string; mode?: number },
  ): ZipArchiveInstance
  append(source: string | Buffer, options: { name: string }): ZipArchiveInstance
  finalize(): Promise<void>
}

const ZipArchive = (
  archiverPkg as unknown as {
    ZipArchive: new (options?: {
      zlib?: { level?: number }
    }) => ZipArchiveInstance
  }
).ZipArchive

export interface ExtensionConfigEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtimeMs: number
  readOnly: boolean
  ownership?: ReturnType<MarketplaceOwnershipIndex['metadata']>['ownership']
}

export type ExtensionConfigServiceOptions = {
  storage: ConfigStoragePort
  ownership?: () =>
    MarketplaceOwnershipIndex | Promise<MarketplaceOwnershipIndex>
}

function relativeParent(relative: string): string {
  const parent = path.posix.dirname(relative)
  return parent === '.' ? '' : parent
}

function assertFilePath(parsed: ReturnType<typeof parseUserConfigPath>): void {
  if (parsed.components.length < 2) {
    throw new UserConfigError(
      403,
      'EROOT',
      'Files must be inside an allowed config root',
    )
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 8192)
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

function assertContent(value: unknown): Buffer {
  if (typeof value !== 'string') {
    throw new UserConfigError(400, 'EINVAL', 'Content must be a string')
  }
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > MAX_CONFIG_WRITE_BYTES) {
    throw new UserConfigError(
      413,
      'E2BIG',
      `Content exceeds ${MAX_CONFIG_WRITE_BYTES} bytes`,
    )
  }
  return bytes
}

function expectedMtime(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UserConfigError(400, 'EINVAL', 'mtimeMs must be a finite number')
  }
  return value
}

function copyName(name: string, attempt: number): string {
  const extension = path.posix.extname(name)
  const stem = path.posix.basename(name, extension)
  return `${stem}-copy${attempt === 1 ? '' : `-${attempt}`}${extension}`
}

async function atomicLocalRewrite(
  target: string,
  content: string,
  mode: number,
): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  )
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' })
    await fs.rename(temp, target)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

async function readLocalTextNoFollow(
  filePath: string,
  options: { allowMissing?: boolean } = {},
): Promise<{ raw: string; mode: number } | undefined> {
  let before: fsSync.Stats
  try {
    before = await fs.lstat(filePath)
  } catch (error) {
    if (
      options.allowMissing &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
  if (before.isSymbolicLink()) {
    throw new UserConfigError(
      403,
      'ESYMLINK',
      'Staged file must not be a symbolic link',
    )
  }
  if (!before.isFile()) {
    throw new UserConfigError(
      400,
      'ESPECIAL',
      'Staged file must be a regular file',
    )
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(
      filePath,
      fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0),
    )
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new UserConfigError(
        409,
        'ESTALE',
        'Staged file changed while it was opened',
      )
    }
    return { raw: await handle.readFile('utf8'), mode: opened.mode & 0o777 }
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function rewriteCopiedSkillName(
  localRoot: string,
  destinationName: string,
): Promise<void> {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(destinationName) ||
    destinationName.includes('--')
  ) {
    throw new UserConfigError(
      400,
      'EINVAL',
      'Skill copy name must follow the Agent Skills identifier standard',
    )
  }
  try {
    const skillFile = path.join(localRoot, 'SKILL.md')
    const file = await readLocalTextNoFollow(skillFile, { allowMissing: true })
    if (!file) return
    const parsed = matter(file.raw)
    await atomicLocalRewrite(
      skillFile,
      matter.stringify(parsed.content, {
        ...parsed.data,
        name: destinationName,
      }),
      file.mode,
    )
  } catch (error) {
    if (error instanceof UserConfigError) throw error
    throw new UserConfigError(400, 'EINVAL', 'Copied SKILL.md is invalid')
  }
}

async function rewriteCopiedAgentName(
  localFile: string,
  destinationName: string,
): Promise<void> {
  const agentName = path.posix.basename(destinationName, '.md')
  if (
    !destinationName.toLowerCase().endsWith('.md') ||
    !/^[a-z0-9][a-z0-9_-]*$/i.test(agentName)
  ) {
    throw new UserConfigError(
      400,
      'EINVAL',
      'Agent copy name must be a safe Markdown identifier',
    )
  }
  try {
    const file = await readLocalTextNoFollow(localFile)
    if (!file) {
      throw new UserConfigError(404, 'ENOENT', 'Copied agent file is missing')
    }
    const parsed = matter(file.raw)
    await atomicLocalRewrite(
      localFile,
      matter.stringify(parsed.content, {
        ...parsed.data,
        name: agentName,
      }),
      file.mode,
    )
  } catch (error) {
    if (error instanceof UserConfigError) throw error
    throw new UserConfigError(400, 'EINVAL', 'Copied agent Markdown is invalid')
  }
}

async function collectDownloadEntries(absoluteRoot: string): Promise<
  Array<{
    absolute: string
    relative: string
    isDirectory: boolean
    mode: number
  }>
> {
  const entries: Array<{
    absolute: string
    relative: string
    isDirectory: boolean
    mode: number
  }> = []
  const walk = async (absoluteDir: string, relativeDir: string) => {
    const children = await fs.readdir(absoluteDir, { withFileTypes: true })
    if (children.length === 0 && relativeDir) {
      const stats = await fs.lstat(absoluteDir)
      entries.push({
        absolute: absoluteDir,
        relative: `${relativeDir}/`,
        isDirectory: true,
        mode: stats.mode,
      })
    }
    for (const child of children) {
      const absolute = path.join(absoluteDir, child.name)
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name
      const stats = await fs.lstat(absolute)
      if (stats.isSymbolicLink()) {
        throw new UserConfigError(
          403,
          'ESYMLINK',
          `Symbolic links are not allowed: ${relative}`,
        )
      }
      if (stats.isDirectory()) await walk(absolute, relative)
      else if (stats.isFile()) {
        entries.push({
          absolute,
          relative,
          isDirectory: false,
          mode: stats.mode,
        })
      } else {
        throw new UserConfigError(
          400,
          'ESPECIAL',
          `Special files are not allowed: ${relative}`,
        )
      }
    }
  }
  await walk(absoluteRoot, '')
  return entries
}

export function mapExtensionConfigError(error: unknown): UserConfigError {
  if (error instanceof UserConfigError) return error
  if (error instanceof MarketplaceError) {
    return new UserConfigError(
      error.statusCode,
      error.statusCode === 413 ? 'E2BIG' : 'EZIP',
      error.message,
    )
  }
  if (error instanceof ShellFsError) {
    const statusByCode: Record<string, number> = {
      ENOENT: 404,
      EEXIST: 409,
      EISDIR: 400,
      ENOTDIR: 400,
      EACCES: 403,
      EINVAL: 400,
      ESYMLINK: 403,
      ESPECIAL: 400,
      EMTIME: 409,
    }
    const messageByCode: Record<string, string> = {
      ENOENT: 'Requested path was not found',
      EEXIST: 'Destination already exists',
      EISDIR: 'Path is not a regular file',
      ENOTDIR: 'Path component is not a directory',
      EACCES: 'Filesystem access was denied',
      EINVAL: 'Filesystem operation was rejected',
      ESYMLINK: 'Symbolic links are not allowed',
      ESPECIAL: 'Special files are not allowed',
      EMTIME: 'File modified externally',
    }
    return new UserConfigError(
      statusByCode[error.code] ?? 500,
      error.code,
      messageByCode[error.code] ?? 'Internal server error',
    )
  }
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FILE_COUNT') {
    return new UserConfigError(413, 'E2BIG', 'Upload exceeds configured limits')
  }
  if (code === 'LIMIT_FIELD_COUNT' || code === 'LIMIT_PART_COUNT') {
    return new UserConfigError(413, 'E2BIG', 'Upload has too many parts')
  }
  const errorName =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name)
      : ''
  const errorMessage = error instanceof Error ? error.message : ''
  if (errorName === 'MulterError' || /multipart|boundary/i.test(errorMessage)) {
    return new UserConfigError(400, 'EUPLOAD', 'Invalid multipart upload')
  }
  if (code === 'ENOENT') {
    return new UserConfigError(404, 'ENOENT', 'Requested path was not found')
  }
  if (code === 'EEXIST') {
    return new UserConfigError(409, 'EEXIST', 'Destination already exists')
  }
  if (code === 'ENOTEMPTY') {
    return new UserConfigError(409, 'ENOTEMPTY', 'Directory is not empty')
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new UserConfigError(403, 'EACCES', 'Filesystem access was denied')
  }
  if (code === 'ELOOP') {
    return new UserConfigError(
      403,
      'ESYMLINK',
      'Symbolic links are not allowed',
    )
  }
  return new UserConfigError(500, 'EINTERNAL', 'Internal server error')
}

export class ExtensionConfigService {
  private readonly storage: ConfigStoragePort
  private readonly ownershipLoader: NonNullable<
    ExtensionConfigServiceOptions['ownership']
  >
  private ownershipPromise?: Promise<MarketplaceOwnershipIndex>
  private readyPromise?: Promise<void>

  constructor(options: ExtensionConfigServiceOptions) {
    this.storage = options.storage
    this.ownershipLoader =
      options.ownership ?? (() => MarketplaceOwnershipIndex.empty())
  }

  private ready(): Promise<void> {
    this.readyPromise ??= this.storage.initialize()
    return this.readyPromise
  }

  private ownership(): Promise<MarketplaceOwnershipIndex> {
    this.ownershipPromise ??= Promise.resolve(this.ownershipLoader())
    return this.ownershipPromise
  }

  private async publicEntry(
    entry: ConfigStorageEntry,
    ownership?: MarketplaceOwnershipIndex,
  ): Promise<ExtensionConfigEntry> {
    const index = ownership ?? (await this.ownership())
    return {
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ...index.metadata(entry.path, { isDirectory: entry.isDir }),
    }
  }

  async metadata(): Promise<{
    root: ''
    displayName: string
    allowedRoots: typeof USER_CONFIG_ROOTS
    generation: number
    limits: {
      maxWriteBytes: number
      maxUploadBytes: number
      skillPackage: typeof SKILL_PACKAGE_LIMITS
    }
  }> {
    await this.ready()
    return {
      root: '',
      displayName: this.storage.displayName,
      allowedRoots: USER_CONFIG_ROOTS,
      generation: await this.storage.getGeneration(),
      limits: {
        maxWriteBytes: MAX_CONFIG_WRITE_BYTES,
        maxUploadBytes: MAX_CONFIG_UPLOAD_BYTES,
        skillPackage: SKILL_PACKAGE_LIMITS,
      },
    }
  }

  async list(input: unknown): Promise<{
    dir: string
    parent: string
    entries: ExtensionConfigEntry[]
  }> {
    await this.ready()
    const parsed = parseUserConfigPath(input, { allowRoot: true })
    const ownership = await this.ownership()
    if (!parsed.relative) {
      const entries: ExtensionConfigEntry[] = []
      for (const rootName of USER_CONFIG_ROOTS) {
        const inspected = await this.storage.inspect(rootName)
        if (!inspected.exists) {
          entries.push({
            name: rootName,
            path: rootName,
            isDir: true,
            size: 0,
            mtimeMs: 0,
            readOnly: false,
          })
        } else {
          if (!inspected.isDir) {
            throw new UserConfigError(
              400,
              'ENOTDIR',
              `Allowed root is not a directory: ${rootName}`,
            )
          }
          entries.push(await this.publicEntry(inspected, ownership))
        }
      }
      return { dir: '', parent: '', entries }
    }

    const inspected = await this.storage.inspect(parsed.relative)
    if (!inspected.exists) {
      if (parsed.components.length === 1) {
        return { dir: parsed.relative, parent: '', entries: [] }
      }
      throw new UserConfigError(
        404,
        'ENOENT',
        `Directory not found: ${parsed.relative}`,
      )
    }
    if (!inspected.isDir) {
      throw new UserConfigError(
        400,
        'ENOTDIR',
        `Not a directory: ${parsed.relative}`,
      )
    }
    const entries = await Promise.all(
      (await this.storage.list(parsed.relative)).map(entry =>
        this.publicEntry(entry, ownership),
      ),
    )
    return {
      dir: parsed.relative,
      parent: relativeParent(parsed.relative),
      entries,
    }
  }

  async read(input: unknown): Promise<{
    path: string
    content: string
    size: number
    truncated: boolean
    isBinary: boolean
    mtimeMs: number
    readOnly: boolean
    ownership?: ExtensionConfigEntry['ownership']
  }> {
    await this.ready()
    const parsed = parseUserConfigPath(input)
    assertFilePath(parsed)
    const file = await this.storage.readFile(
      parsed.relative,
      MAX_FILE_PREVIEW_BYTES,
    )
    const binary = isProbablyBinary(file.buffer)
    return {
      path: parsed.relative,
      content: binary ? '' : file.buffer.toString('utf8'),
      size: file.size,
      truncated: file.size > MAX_FILE_PREVIEW_BYTES,
      isBinary: binary,
      mtimeMs: file.mtimeMs,
      ...(await this.ownership()).metadata(parsed.relative),
    }
  }

  async create(input: {
    path?: unknown
    content?: unknown
  }): Promise<ExtensionConfigEntry & { generation: number }> {
    await this.ready()
    const parsed = parseUserConfigPath(input.path)
    assertFilePath(parsed)
    const ownership = await this.ownership()
    ownership.assertWritable(parsed.relative)
    const entry = await this.storage.writeFile(
      parsed.relative,
      assertContent(input.content ?? ''),
      { createOnly: true },
    )
    const generation = await this.storage.bumpGeneration()
    return { ...(await this.publicEntry(entry, ownership)), generation }
  }

  async save(input: {
    path?: unknown
    content?: unknown
    mtimeMs?: unknown
  }): Promise<ExtensionConfigEntry & { generation: number }> {
    await this.ready()
    const parsed = parseUserConfigPath(input.path)
    assertFilePath(parsed)
    const ownership = await this.ownership()
    ownership.assertWritable(parsed.relative)
    const entry = await this.storage.writeFile(
      parsed.relative,
      assertContent(input.content),
      {
        createOnly: false,
        expectedMtimeMs: expectedMtime(input.mtimeMs),
      },
    )
    const generation = await this.storage.bumpGeneration()
    return { ...(await this.publicEntry(entry, ownership)), generation }
  }

  async mkdir(input: { path?: unknown }): Promise<{
    path: string
    generation: number
  }> {
    await this.ready()
    const parsed = parseUserConfigPath(input.path)
    const ownership = await this.ownership()
    ownership.assertWritable(parsed.relative)
    const entry = await this.storage.ensureDirectory(parsed.relative)
    return {
      path: entry.path,
      generation: await this.storage.bumpGeneration(),
    }
  }

  async remove(input: unknown): Promise<{
    path: string
    generation: number
  }> {
    await this.ready()
    const parsed = parseUserConfigPath(input)
    const ownership = await this.ownership()
    ownership.assertWritable(parsed.relative, { recursiveMutation: true })
    await this.storage.remove(parsed.relative)
    return {
      path: parsed.relative,
      generation: await this.storage.bumpGeneration(),
    }
  }

  private async unusedCopyDestination(
    parent: string,
    originalName: string,
    requestedName: unknown,
  ): Promise<{ name: string; relative: string }> {
    if (requestedName !== undefined) {
      const name = assertUserConfigName(requestedName)
      const relative = parent ? `${parent}/${name}` : name
      if ((await this.storage.inspect(relative)).exists) {
        throw new UserConfigError(
          409,
          'EEXIST',
          `Destination already exists: ${relative}`,
        )
      }
      return { name, relative }
    }
    for (let attempt = 1; attempt <= 10_000; attempt += 1) {
      const name = copyName(originalName, attempt)
      const relative = parent ? `${parent}/${name}` : name
      if (!(await this.storage.inspect(relative)).exists) {
        return { name, relative }
      }
    }
    throw new UserConfigError(409, 'EEXIST', 'No available duplicate name')
  }

  async duplicate(input: {
    path?: unknown
    name?: unknown
  }): Promise<ExtensionConfigEntry & { generation: number }> {
    await this.ready()
    const sourcePath = parseUserConfigPath(input.path)
    const source = await this.storage.inspect(sourcePath.relative, {
      requireExists: true,
    })
    const parent = relativeParent(source.path)
    const destination = await this.unusedCopyDestination(
      parent,
      path.posix.basename(source.path),
      input.name,
    )
    const ownership = await this.ownership()
    ownership.assertWritable(destination.relative)

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-config-copy-'),
    )
    try {
      const exported = await this.storage.exportEntry(source.path, tempRoot)
      const topLevelSkill =
        exported.isDir &&
        sourcePath.components.length === 2 &&
        sourcePath.components[0] === 'skills'
      const topLevelAgent =
        !exported.isDir &&
        sourcePath.components.length === 2 &&
        sourcePath.components[0] === 'agents'
      if (topLevelSkill) {
        await rewriteCopiedSkillName(exported.localPath, destination.name)
      }
      if (topLevelAgent) {
        await rewriteCopiedAgentName(exported.localPath, destination.name)
      }
      const entry = await this.storage.publishEntry(
        exported.localPath,
        destination.relative,
      )
      const generation = await this.storage.bumpGeneration()
      return { ...(await this.publicEntry(entry, ownership)), generation }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async uniqueUploadPath(
    dir: string,
    originalName: string,
  ): Promise<{ relative: string; name: string }> {
    const extension = path.posix.extname(originalName)
    const stem = path.posix.basename(originalName, extension)
    for (let attempt = 0; attempt <= 10_000; attempt += 1) {
      const name =
        attempt === 0 ? originalName : `${stem} (${attempt})${extension}`
      const relative = `${dir}/${name}`
      if (!(await this.storage.inspect(relative)).exists) {
        return { relative, name }
      }
    }
    throw new UserConfigError(409, 'EEXIST', 'No available upload filename')
  }

  async upload(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{
    dir: string
    uploaded: Array<{
      name: string
      path: string
      size: number
      kind: 'file' | 'skill'
    }>
    generation: number
  }> {
    await this.ready()
    const upload = await receiveUpload(req, res, {
      maxFileBytes: SKILL_PACKAGE_LIMITS.maxDownloadBytes,
      maxFiles: 20,
      maxFields: 10,
      preservePath: true,
    })
    const created: string[] = []
    let createdUploadDir = false
    try {
      const parsedDir = parseUserConfigPath(upload.fields.dir)
      if (upload.files.length === 0) {
        throw new UserConfigError(400, 'EINVAL', 'No files in upload')
      }
      // Fail closed on unreadable Marketplace ownership before creating any
      // directory or publishing an uploaded file.
      const ownership = await this.ownership()
      const existingDir = await this.storage.inspect(parsedDir.relative)
      if (!existingDir.exists) {
        if (parsedDir.components.length !== 1) {
          throw new UserConfigError(
            404,
            'ENOENT',
            `Directory not found: ${parsedDir.relative}`,
          )
        }
        await this.storage.ensureDirectory(parsedDir.relative)
        createdUploadDir = true
      } else if (!existingDir.isDir) {
        throw new UserConfigError(
          400,
          'ENOTDIR',
          `Not a directory: ${parsedDir.relative}`,
        )
      }
      ownership.assertWritable(parsedDir.relative)

      const uploaded: Array<{
        name: string
        path: string
        size: number
        kind: 'file' | 'skill'
      }> = []
      for (const file of upload.files) {
        if (!file.name) {
          throw new UserConfigError(400, 'EINVAL', 'Upload filename is unsafe')
        }
        const skillPackage =
          file.name.toLowerCase().endsWith('.zip') &&
          (upload.fields.kind === 'skill' || parsedDir.relative === 'skills')
        if (skillPackage) {
          if (file.size > SKILL_PACKAGE_LIMITS.maxDownloadBytes) {
            throw new UserConfigError(
              413,
              'E2BIG',
              'Skill ZIP exceeds download size limit',
            )
          }
          const tempRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), 'extension-config-skill-'),
          )
          try {
            const skill = await extractAndValidateSkillZip(
              await fs.readFile(file.path),
              tempRoot,
            )
            const relative = `skills/${skill.name}`
            ownership.assertWritable(relative)
            if ((await this.storage.inspect(relative)).exists) {
              throw new UserConfigError(
                409,
                'EEXIST',
                `Skill already exists: ${relative}`,
              )
            }
            await this.storage.ensureDirectory('skills')
            await this.storage.publishEntry(skill.root, relative)
            created.push(relative)
            uploaded.push({
              name: skill.name,
              path: relative,
              size: file.size,
              kind: 'skill',
            })
          } finally {
            await fs
              .rm(tempRoot, { recursive: true, force: true })
              .catch(() => {})
          }
          continue
        }

        if (file.size > MAX_CONFIG_UPLOAD_BYTES) {
          throw new UserConfigError(
            413,
            'E2BIG',
            `Uploaded file exceeds ${MAX_CONFIG_UPLOAD_BYTES} bytes`,
          )
        }
        const destination = await this.uniqueUploadPath(
          parsedDir.relative,
          file.name,
        )
        ownership.assertWritable(destination.relative)
        await this.storage.publishEntry(file.path, destination.relative)
        created.push(destination.relative)
        uploaded.push({
          name: destination.name,
          path: destination.relative,
          size: file.size,
          kind: 'file',
        })
      }
      return {
        dir: parsedDir.relative,
        uploaded,
        generation: await this.storage.bumpGeneration(),
      }
    } catch (error) {
      for (const relative of created.reverse()) {
        await this.storage.remove(relative).catch(() => {})
      }
      if (createdUploadDir) {
        const dir = upload.fields.dir
        if (typeof dir === 'string')
          await this.storage.remove(dir).catch(() => {})
      }
      throw error
    } finally {
      await upload.cleanup()
    }
  }

  async download(res: ServerResponse, input: unknown): Promise<void> {
    await this.ready()
    const parsed = parseUserConfigPath(input)
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-config-download-'),
    )
    try {
      const exported = await this.storage.exportEntry(parsed.relative, tempRoot)
      if (!exported.isDir) {
        const handle = await fs.open(
          exported.localPath,
          fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0),
        )
        const stats = await handle.stat()
        if (!stats.isFile()) {
          await handle.close()
          throw new UserConfigError(
            400,
            'ESPECIAL',
            'Path is not a regular file',
          )
        }
        res.writeHead(200, {
          'Content-Type': mimeTypeFor(parsed.relative),
          'Content-Length': String(stats.size),
          'Content-Disposition': contentDisposition(
            path.posix.basename(parsed.relative),
          ),
          'X-Content-Type-Options': 'nosniff',
        })
        await new Promise<void>((resolve, reject) => {
          const stream = handle.createReadStream({ autoClose: true })
          stream.on('error', reject)
          res.on('close', resolve)
          stream.on('end', resolve)
          stream.pipe(res)
        })
        return
      }

      const entries = await collectDownloadEntries(exported.localPath)
      const zipName = `${path.posix.basename(parsed.relative)}.zip`
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(zipName),
        'X-Content-Type-Options': 'nosniff',
      })
      const archive = new ZipArchive({ zlib: { level: 9 } })
      archive.on('error', () => res.destroy())
      archive.pipe(res)
      for (const entry of entries) {
        if (entry.isDirectory) archive.append('', { name: entry.relative })
        else {
          archive.file(entry.absolute, {
            name: entry.relative,
            mode: entry.mode,
          })
        }
      }
      await archive.finalize()
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
}
