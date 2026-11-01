import { promises as fs } from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import extract from 'extract-zip'
import matter from 'gray-matter'
import { getAppDirName } from '../../utils/app-dir.js'
import {
  bumpUserConfigGeneration,
  USER_CONFIG_GENERATION_FILE,
} from '../../services/user-config-generation.js'
import { parseAgentFromMarkdown } from '../../tools/AgentTool/mergeAgents.js'
import {
  SKILL_ARCHIVE_DOWNLOAD_LIMIT,
  SKILL_PACKAGE_POLICY,
} from '../../skills/package-policy.js'
import { MarketplaceError } from './http.js'
import type {
  MarketplaceArtifact,
  MarketplaceBundlePreview,
  MarketplaceItem,
  MarketplaceKind,
} from './types.js'
import type { MarketplaceProviderConfig } from '../../core/types.js'

interface LockEntry {
  providerId: string
  externalId: string
  kind: MarketplaceKind
  name: string
  version?: string
  hash?: string
  path: string
  installedAt: string
  files?: Array<{ path: string; hash: string; backupPath?: string }>
}

interface MarketplaceLock {
  version: 1
  entries: LockEntry[]
}

const DEFAULT_DOWNLOAD_LIMIT = 10 * 1024 * 1024
const DEFAULT_EXTRACT_LIMIT = 25 * 1024 * 1024
const DEFAULT_FILE_LIMIT = 1000

export const SKILL_PACKAGE_LIMITS = {
  maxDownloadBytes: SKILL_ARCHIVE_DOWNLOAD_LIMIT,
  maxExtractBytes: SKILL_PACKAGE_POLICY.maxTotalBytes,
  maxFiles: SKILL_PACKAGE_POLICY.maxFiles,
  maxDirectories: SKILL_PACKAGE_POLICY.maxDirectories,
  maxSingleFileBytes: SKILL_PACKAGE_POLICY.maxSingleFileBytes,
} as const

export interface SkillPackageLimits {
  maxDownloadBytes?: number
  maxExtractBytes?: number
  maxFiles?: number
  maxDirectories?: number
  maxSingleFileBytes?: number
}

function lockPath(cwd: string): string {
  return path.join(cwd, getAppDirName(), 'marketplace-lock.json')
}

function bundleBackupRoot(
  cwd: string,
  providerId: string,
  externalId: string,
): string {
  const owner = `${safeBundleName(providerId)}-${crypto
    .createHash('sha256')
    .update(externalId)
    .digest('hex')
    .slice(0, 16)}`
  return path.join(cwd, getAppDirName(), '.marketplace-backups', owner)
}

function resolveBundleBackup(
  cwd: string,
  providerId: string,
  externalId: string,
  relativePath: string,
): string {
  const root = path.resolve(bundleBackupRoot(cwd, providerId, externalId))
  const candidate = path.resolve(cwd, relativePath)
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new MarketplaceError('Installed bundle backup path is invalid', 409)
  }
  return candidate
}

/**
 * Load the lock file and drop entries whose installed files are gone.
 *
 * This never writes: read-only endpoints (catalog/detail) must not rewrite
 * workspace state. Pruned entries are persisted the next time install or
 * uninstall writes the lock. With `strict`, an unreadable or malformed lock is
 * an error instead of an empty lock, so a mutation cannot silently overwrite
 * (and orphan the backups of) an existing install history.
 */
async function loadMarketplaceLock(
  cwd: string,
  options: { strict: boolean },
): Promise<MarketplaceLock> {
  let raw: string
  try {
    raw = await fs.readFile(lockPath(cwd), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, entries: [] }
    }
    if (options.strict) {
      throw new MarketplaceError(
        `Cannot read marketplace lock file: ${(error as Error).message}`,
        500,
      )
    }
    console.warn(
      `[marketplace] failed to read lock file: ${(error as Error).message}`,
    )
    return { version: 1, entries: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    parsed = undefined
    if (!options.strict) {
      console.warn(
        `[marketplace] failed to parse lock file: ${(error as Error).message}`,
      )
    }
  }
  const candidate = parsed as Partial<MarketplaceLock> | undefined
  if (candidate?.version !== 1 || !Array.isArray(candidate.entries)) {
    if (options.strict) {
      throw new MarketplaceError(
        'Marketplace lock file is malformed; repair or remove it before installing',
        500,
      )
    }
    return { version: 1, entries: [] }
  }

  const present = (
    await Promise.all(
      candidate.entries.map(async entry => ({
        entry,
        exists: await installedEntryExists(cwd, entry),
      })),
    )
  )
    .filter(item => item.exists)
    .map(item => item.entry)
  return { version: 1, entries: present }
}

export function readMarketplaceLock(cwd: string): Promise<MarketplaceLock> {
  return loadMarketplaceLock(cwd, { strict: false })
}

/** Strict lock read for mutations or ownership enforcement. */
export function readMarketplaceLockStrict(
  cwd: string,
): Promise<MarketplaceLock> {
  return loadMarketplaceLock(cwd, { strict: true })
}

function expectedEntryPaths(entry: LockEntry): string[] {
  if (entry.kind === 'skill') {
    return [
      path.join(getAppDirName(), 'skills', entry.name),
      path.join('.agents', 'skills', entry.name),
    ]
  }
  if (entry.kind === 'bundle') {
    return [path.join(getAppDirName(), 'bundles', safeBundleName(entry.name))]
  }
  return [path.join(getAppDirName(), 'agents', `${entry.name}.md`)]
}

function safeBundleName(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  if (!safe) {
    throw new MarketplaceError('Bundle name is not a safe identifier', 400)
  }
  return safe
}

async function installedEntryExists(
  cwd: string,
  entry: LockEntry,
): Promise<boolean> {
  let expected: string[]
  try {
    expected = expectedEntryPaths(entry)
  } catch {
    // A single unparseable entry (e.g. unsafe bundle name) must not take the
    // rest of the lock down with it.
    return false
  }
  if (!expected.includes(entry.path)) return false
  try {
    const stats = await fs.lstat(path.join(cwd, entry.path))
    return entry.kind === 'agent' ? stats.isFile() : stats.isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeMarketplaceLock(
  cwd: string,
  lock: MarketplaceLock,
): Promise<void> {
  const destination = lockPath(cwd)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temp = `${destination}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  try {
    await atomicReplace(temp, destination)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

function entryKey(
  providerId: string,
  kind: MarketplaceKind,
  externalId: string,
): string {
  return `${providerId}\0${kind}\0${externalId}`
}

function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0')
  ) {
    throw new MarketplaceError(
      `Unsafe marketplace artifact path: ${relativePath}`,
      400,
    )
  }
  return normalized
}

async function walkFiles(
  root: string,
): Promise<Array<{ path: string; size: number }>> {
  const output: Array<{ path: string; size: number }> = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(root, full)
      const stats = await fs.lstat(full)
      if (stats.isSymbolicLink()) {
        throw new MarketplaceError(
          `Symbolic links are not allowed in marketplace artifacts: ${relative}`,
          400,
        )
      }
      if (stats.isDirectory()) await walk(full)
      else if (stats.isFile()) output.push({ path: relative, size: stats.size })
    }
  }
  await walk(root)
  return output
}

async function countDirectories(root: string): Promise<number> {
  let count = 0
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      count++
      await walk(path.join(dir, entry.name))
    }
  }
  await walk(root)
  return count
}

async function hashFile(filePath: string): Promise<string> {
  return crypto
    .createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex')
}

interface BundleSourceFile {
  path: string
  size: number
  hash: string
}

interface BundleDeployFile extends BundleSourceFile {
  targetPath: string
  contents: Buffer
}

function assertBundleTargetPath(relativePath: string): string {
  const safe = assertSafeRelativePath(relativePath)
  const lower = safe.toLowerCase()
  const appDir = getAppDirName().replace(/\\/g, '/').toLowerCase()
  if (
    lower === '.git' ||
    lower.startsWith('.git/') ||
    lower === `${appDir}/marketplace-lock.json` ||
    lower === `${appDir}/${USER_CONFIG_GENERATION_FILE}` ||
    lower.startsWith(`${appDir}/.marketplace-tmp/`) ||
    lower.startsWith(`${appDir}/.marketplace-backups/`) ||
    lower.startsWith(`${appDir}/bundles/`)
  ) {
    throw new MarketplaceError(
      `AI Bundle cannot manage protected workspace path: ${relativePath}`,
      400,
    )
  }
  return safe
}

function bundleTargetPath(sourcePath: string): string | undefined {
  const source = assertSafeRelativePath(sourcePath)
  const appDir = getAppDirName().replace(/\\/g, '/')
  let match: RegExpMatchArray | null

  if (source.toLowerCase().startsWith(`${appDir.toLowerCase()}/`)) {
    return assertBundleTargetPath(source)
  }
  if ((match = source.match(/^\.agents\/skills\/(.+)$/i))) {
    return assertBundleTargetPath(`${appDir}/skills/${match[1]}`)
  }
  if ((match = source.match(/^\.github\/skills\/(.+)$/i))) {
    return assertBundleTargetPath(`${appDir}/skills/${match[1]}`)
  }
  if ((match = source.match(/^\.github\/agents\/(.+)\.agent\.md$/i))) {
    return assertBundleTargetPath(`${appDir}/agents/${match[1]}.md`)
  }
  if ((match = source.match(/^\.github\/agents\/(.+\.md)$/i))) {
    return assertBundleTargetPath(`${appDir}/agents/${match[1]}`)
  }
  if (
    source.toLowerCase() === '.github/copilot-instructions.md' ||
    source.toLowerCase() === 'agents.md'
  ) {
    return assertBundleTargetPath(`${appDir}/AGENTS.md`)
  }
  if (
    (match = source.match(/^\.github\/instructions\/(.+)\.instructions\.md$/i))
  ) {
    return assertBundleTargetPath(`${appDir}/rules/${match[1]}.md`)
  }
  if ((match = source.match(/^\.github\/prompts\/(.+)\.prompt\.md$/i))) {
    return assertBundleTargetPath(`${appDir}/commands/${match[1]}.md`)
  }
  if ((match = source.match(/^\.cursor\/skills\/(.+)$/i))) {
    return assertBundleTargetPath(`${appDir}/skills/${match[1]}`)
  }
  if ((match = source.match(/^\.cursor\/agents\/(.+\.md)$/i))) {
    return assertBundleTargetPath(`${appDir}/agents/${match[1]}`)
  }
  if ((match = source.match(/^\.cursor\/commands\/(.+\.md)$/i))) {
    return assertBundleTargetPath(`${appDir}/commands/${match[1]}`)
  }
  if ((match = source.match(/^\.cursor\/rules\/(.+)\.mdc$/i))) {
    return assertBundleTargetPath(`${appDir}/rules/${match[1]}.md`)
  }
  if ((match = source.match(/^\.cursor\/rules\/(.+\.md)$/i))) {
    return assertBundleTargetPath(`${appDir}/rules/${match[1]}`)
  }
  if ((match = source.match(/^\.opencode\/skills\/(.+)$/i))) {
    return assertBundleTargetPath(`${appDir}/skills/${match[1]}`)
  }
  if ((match = source.match(/^\.opencode\/agents?\/(.+\.md)$/i))) {
    return assertBundleTargetPath(`${appDir}/agents/${match[1]}`)
  }
  if ((match = source.match(/^\.opencode\/commands\/(.+\.md)$/i))) {
    return assertBundleTargetPath(`${appDir}/commands/${match[1]}`)
  }
  return undefined
}

function transformBundleContents(
  sourcePath: string,
  targetPath: string,
  contents: Buffer,
): Buffer {
  if (
    !targetPath.replace(/\\/g, '/').startsWith(`${getAppDirName()}/rules/`) ||
    !/(\.instructions\.md|\.mdc)$/i.test(sourcePath)
  ) {
    return contents
  }
  try {
    const parsed = matter(contents.toString('utf8'))
    const data = { ...parsed.data } as Record<string, unknown>
    const paths = data.paths ?? data.applyTo ?? data.globs
    delete data.applyTo
    delete data.globs
    delete data.alwaysApply
    if (paths !== undefined) data.paths = paths
    return Buffer.from(matter.stringify(parsed.content, data), 'utf8')
  } catch (error) {
    throw new MarketplaceError(
      `Cannot convert rule '${sourcePath}' to BaiX: ${(error as Error).message}`,
      400,
    )
  }
}

function validateBundleDeployment(files: BundleDeployFile[]): void {
  const appDir = getAppDirName().replace(/\\/g, '/')
  const skillPrefix = `${appDir}/skills/`
  const agentPrefix = `${appDir}/agents/`
  const skillNames = new Set<string>()

  for (const file of files) {
    if (
      file.targetPath.startsWith(agentPrefix) &&
      file.targetPath.toLowerCase().endsWith('.md')
    ) {
      validateAgent(file.contents.toString('utf8'), file.targetPath)
    }
    if (file.targetPath.startsWith(skillPrefix)) {
      const skillName = file.targetPath.slice(skillPrefix.length).split('/')[0]
      if (skillName) skillNames.add(skillName)
    }
  }

  for (const skillName of skillNames) {
    const skillFile = files.find(
      file =>
        file.targetPath.toLowerCase() ===
        `${skillPrefix}${skillName}/skill.md`.toLowerCase(),
    )
    // Bundles may place shared scripts or references next to actual skill
    // directories. BaiX keeps those relative paths available to the skills,
    // but only directories containing SKILL.md are independently loadable.
    if (!skillFile) continue
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(skillFile.contents.toString('utf8'))
    } catch (error) {
      throw new MarketplaceError(
        `Invalid SKILL.md for '${skillName}': ${(error as Error).message}`,
        400,
      )
    }
    if (parsed.data.name !== skillName) {
      throw new MarketplaceError(
        `Converted skill directory '${skillName}' does not match SKILL.md name '${String(parsed.data.name ?? '')}'`,
        400,
      )
    }
    if (
      typeof parsed.data.description !== 'string' ||
      !parsed.data.description.trim()
    ) {
      throw new MarketplaceError(
        `Converted skill '${skillName}' must define a description`,
        400,
      )
    }
  }
}

async function bundleDeploymentFiles(
  root: string,
  files: BundleSourceFile[],
): Promise<BundleDeployFile[]> {
  const targets = new Map<string, string>()
  const output: BundleDeployFile[] = []
  for (const file of files) {
    const targetPath = bundleTargetPath(file.path)
    if (!targetPath) continue
    const key = targetPath.toLowerCase()
    const existing = targets.get(key)
    if (existing) {
      throw new MarketplaceError(
        `AI Bundle files '${existing}' and '${file.path}' map to the same BaiX path '${targetPath}'`,
        400,
      )
    }
    targets.set(key, file.path)
    const contents = transformBundleContents(
      file.path,
      targetPath,
      await fs.readFile(path.join(root, file.path)),
    )
    output.push({
      ...file,
      targetPath,
      contents,
      size: contents.byteLength,
      hash: crypto.createHash('sha256').update(contents).digest('hex'),
    })
  }
  validateBundleDeployment(output)
  return output
}

async function materializeBundle(
  artifact: Extract<MarketplaceArtifact, { kind: 'bundle' }>,
  tempRoot: string,
  config: MarketplaceProviderConfig,
): Promise<{
  root: string
  files: BundleSourceFile[]
}> {
  if (
    artifact.bytes.byteLength >
    (config.maxDownloadBytes ?? DEFAULT_DOWNLOAD_LIMIT)
  ) {
    throw new MarketplaceError('AI Bundle exceeds download size limit', 413)
  }
  const unpack = path.join(tempRoot, 'bundle')
  const zipPath = path.join(tempRoot, 'bundle.zip')
  await fs.mkdir(unpack, { recursive: true })
  await fs.writeFile(zipPath, artifact.bytes)

  const maxFiles = config.maxFiles ?? DEFAULT_FILE_LIMIT
  const maxExtractBytes = config.maxExtractBytes ?? DEFAULT_EXTRACT_LIMIT
  let count = 0
  let declaredBytes = 0
  await extract(zipPath, {
    dir: unpack,
    onEntry(entry) {
      assertBundleTargetPath(entry.fileName)
      count += 1
      declaredBytes += entry.uncompressedSize
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
      if ((unixMode & 0o170000) === 0o120000) {
        throw new MarketplaceError(
          'AI Bundle ZIP contains a symbolic link',
          400,
        )
      }
      if (count > maxFiles || declaredBytes > maxExtractBytes) {
        throw new MarketplaceError(
          'AI Bundle ZIP exceeds extraction limits',
          413,
        )
      }
    },
  })

  const extracted = await walkFiles(unpack)
  if (
    extracted.length === 0 ||
    extracted.length > maxFiles ||
    extracted.reduce((sum, file) => sum + file.size, 0) > maxExtractBytes
  ) {
    throw new MarketplaceError(
      extracted.length === 0
        ? 'AI Bundle is empty'
        : 'AI Bundle exceeds extraction limits',
      extracted.length === 0 ? 400 : 413,
    )
  }
  const files = await Promise.all(
    extracted.map(async file => {
      const relative = assertBundleTargetPath(file.path)
      return {
        path: relative,
        size: file.size,
        hash: await hashFile(path.join(unpack, relative)),
      }
    }),
  )
  return { root: unpack, files }
}

async function pathHash(filePath: string): Promise<string | undefined> {
  try {
    const stats = await fs.lstat(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined
    return await hashFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function bundleFileStates(
  cwd: string,
  sourceFiles: BundleSourceFile[],
  deployFiles: BundleDeployFile[],
  previous?: LockEntry,
): Promise<MarketplaceBundlePreview['files']> {
  return Promise.all(
    sourceFiles.map(async file => {
      const deploy = deployFiles.find(item => item.path === file.path)
      if (!deploy) {
        return {
          sourcePath: file.path,
          size: file.size,
          state: 'archiveOnly' as const,
        }
      }
      const destination = path.join(cwd, deploy.targetPath)
      const [exists, currentHash] = await Promise.all([
        pathExists(destination),
        pathHash(destination),
      ])
      const owned = previous?.files?.find(
        item => item.path === deploy.targetPath,
      )
      let state: MarketplaceBundlePreview['files'][number]['state'] = 'ready'
      if (exists) {
        state = !owned
          ? 'conflict'
          : currentHash === owned.hash
            ? 'owned'
            : 'modified'
      }
      return {
        sourcePath: file.path,
        targetPath: deploy.targetPath,
        size: file.size,
        state,
      }
    }),
  )
}

async function materializeSkill(
  artifact: Extract<MarketplaceArtifact, { kind: 'skill' }>,
  tempRoot: string,
  config: MarketplaceProviderConfig & SkillPackageLimits,
): Promise<string> {
  const unpack = path.join(tempRoot, 'unpack')
  await fs.mkdir(unpack, { recursive: true })
  const maxFiles = Math.min(
    config.maxFiles ?? SKILL_PACKAGE_POLICY.maxFiles,
    SKILL_PACKAGE_POLICY.maxFiles,
  )
  const maxDirectories = Math.min(
    config.maxDirectories ?? SKILL_PACKAGE_POLICY.maxDirectories,
    SKILL_PACKAGE_POLICY.maxDirectories,
  )
  const maxSingleFileBytes = Math.min(
    config.maxSingleFileBytes ?? SKILL_PACKAGE_POLICY.maxSingleFileBytes,
    SKILL_PACKAGE_POLICY.maxSingleFileBytes,
  )
  const maxExtractBytes = Math.min(
    config.maxExtractBytes ?? SKILL_PACKAGE_POLICY.maxTotalBytes,
    SKILL_PACKAGE_POLICY.maxTotalBytes,
  )

  if (artifact.format === 'files') {
    if (artifact.files.length > maxFiles) {
      throw new MarketplaceError('Skill contains too many files', 413)
    }
    let total = 0
    for (const file of artifact.files) {
      const relative = assertSafeRelativePath(file.path)
      const bytes = Buffer.byteLength(file.contents)
      if (bytes > maxSingleFileBytes) {
        throw new MarketplaceError('Skill contains an oversized file', 413)
      }
      total += bytes
      if (total > maxExtractBytes) {
        throw new MarketplaceError('Skill exceeds extracted size limit', 413)
      }
      const destination = path.resolve(unpack, relative)
      if (
        destination !== unpack &&
        !destination.startsWith(`${path.resolve(unpack)}${path.sep}`)
      ) {
        throw new MarketplaceError(
          'Skill file escapes extraction directory',
          400,
        )
      }
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, file.contents, 'utf8')
    }
  } else {
    if (
      artifact.bytes.byteLength >
      Math.min(
        config.maxDownloadBytes ?? SKILL_ARCHIVE_DOWNLOAD_LIMIT,
        SKILL_ARCHIVE_DOWNLOAD_LIMIT,
      )
    ) {
      throw new MarketplaceError('Skill exceeds download size limit', 413)
    }
    const zipPath = path.join(tempRoot, 'skill.zip')
    await fs.writeFile(zipPath, artifact.bytes)
    let fileCount = 0
    let directoryCount = 0
    let declaredBytes = 0
    try {
      await extract(zipPath, {
        dir: unpack,
        onEntry(entry) {
          assertSafeRelativePath(entry.fileName)
          const directory = entry.fileName.replace(/\\/g, '/').endsWith('/')
          if (directory) {
            directoryCount++
          } else {
            fileCount++
            declaredBytes += entry.uncompressedSize
            if (entry.uncompressedSize > maxSingleFileBytes) {
              throw new MarketplaceError(
                'Skill ZIP contains an oversized file',
                413,
              )
            }
          }
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
          if ((unixMode & 0o170000) === 0o120000) {
            throw new MarketplaceError(
              'Skill ZIP contains a symbolic link',
              400,
            )
          }
          if (
            fileCount > maxFiles ||
            directoryCount > maxDirectories ||
            declaredBytes > maxExtractBytes
          ) {
            throw new MarketplaceError(
              'Skill ZIP exceeds extraction limits',
              413,
            )
          }
        },
      })
    } catch (error) {
      if (error instanceof MarketplaceError) throw error
      throw new MarketplaceError(
        'Skill ZIP is invalid or contains an unsafe path',
        400,
      )
    }
  }

  const files = await walkFiles(unpack)
  const directories = await countDirectories(unpack)
  if (
    files.length > maxFiles ||
    directories > maxDirectories ||
    files.some(file => file.size > maxSingleFileBytes) ||
    files.reduce((sum, file) => sum + file.size, 0) > maxExtractBytes
  ) {
    throw new MarketplaceError('Skill exceeds extraction limits', 413)
  }
  const skillFiles = files.filter(
    file => path.basename(file.path).toLowerCase() === 'skill.md',
  )
  if (skillFiles.length !== 1) {
    throw new MarketplaceError(
      'Skill artifact must contain exactly one SKILL.md',
      400,
    )
  }
  return path.dirname(path.join(unpack, skillFiles[0]!.path))
}

async function validateStandardSkill(
  skillRoot: string,
): Promise<{ name: string; hash: string }> {
  const filePath = path.join(skillRoot, 'SKILL.md')
  const raw = await fs.readFile(filePath, 'utf8')
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(raw)
  } catch (error) {
    throw new MarketplaceError(
      `Invalid SKILL.md frontmatter: ${(error as Error).message}`,
      400,
    )
  }
  const name = typeof parsed.data.name === 'string' ? parsed.data.name : ''
  const description =
    typeof parsed.data.description === 'string' ? parsed.data.description : ''
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) ||
    name.includes('--')
  ) {
    throw new MarketplaceError(
      'SKILL.md name must follow the Agent Skills identifier standard',
      400,
    )
  }
  if (!description.trim() || description.length > 1024) {
    throw new MarketplaceError(
      'SKILL.md description must contain 1-1024 characters',
      400,
    )
  }
  const parent = path.basename(skillRoot)
  if (parent !== 'unpack' && parent !== name) {
    throw new MarketplaceError(
      `SKILL.md name '${name}' does not match parent directory '${parent}'`,
      400,
    )
  }
  return {
    name,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
  }
}

/**
 * Shared secure Skill ZIP pipeline for Marketplace and direct user uploads.
 *
 * `root` remains inside `tempRoot`; callers must copy it to their final
 * destination before removing that temporary directory.
 */
export async function extractAndValidateSkillZip(
  bytes: Buffer,
  tempRoot: string,
  limits: SkillPackageLimits = {},
): Promise<{ root: string; name: string; hash: string }> {
  const root = await materializeSkill(
    {
      kind: 'skill',
      format: 'zip',
      bytes,
      item: {
        providerId: 'user-upload',
        externalId: 'user-upload',
        kind: 'skill',
        name: 'user-upload',
      },
    },
    tempRoot,
    {
      id: 'user-upload',
      type: 'skills-sh',
      baseURL: 'https://invalid.local',
      ...limits,
    },
  )
  return { root, ...(await validateStandardSkill(root)) }
}

function validateAgent(
  contents: string,
  filePath: string,
): { name: string; hash: string } {
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(contents)
  } catch (error) {
    throw new MarketplaceError(
      `Invalid agent frontmatter: ${(error as Error).message}`,
      400,
    )
  }
  const result = parseAgentFromMarkdown({
    filePath,
    baseDir: path.dirname(filePath),
    source: 'project',
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content,
  })
  if (!result.agent) {
    throw new MarketplaceError(
      result.error ?? 'Agent must define a valid name, description, and body',
      400,
    )
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(result.agent.agentType)) {
    throw new MarketplaceError('Agent name is not a safe identifier', 400)
  }
  return {
    name: result.agent.agentType,
    hash: crypto.createHash('sha256').update(contents).digest('hex'),
  }
}

async function atomicReplace(
  source: string,
  destination: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const stage = `${destination}.${crypto.randomUUID()}.stage`
  const backup = `${destination}.${crypto.randomUUID()}.backup`
  const sourceStats = await fs.stat(source)
  if (sourceStats.isDirectory()) {
    await fs.cp(source, stage, { recursive: true, errorOnExist: true })
  } else {
    await fs.copyFile(source, stage)
  }
  let hadDestination = false
  try {
    await fs.rename(destination, backup)
    hadDestination = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await fs.rename(stage, destination)
    if (hadDestination) await fs.rm(backup, { recursive: true, force: true })
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true })
    if (hadDestination) await fs.rename(backup, destination).catch(() => {})
    throw error
  }
}

/**
 * Serialise lock-file mutations per workspace. Concurrent install/uninstall
 * requests would otherwise race on read-modify-write of the lock and on the
 * same target paths.
 */
const workspaceQueues = new Map<string, Promise<unknown>>()

async function withWorkspaceLock<T>(
  cwd: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(cwd)
  const previous = workspaceQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  workspaceQueues.set(key, settled)
  try {
    return await run
  } finally {
    if (workspaceQueues.get(key) === settled) workspaceQueues.delete(key)
  }
}

/**
 * Records a snapshot of every workspace path before it is mutated so a failed
 * multi-file install can be rolled back to the pre-install state.
 */
class InstallJournal {
  private readonly undo: Array<() => Promise<void>> = []
  private counter = 0

  constructor(private readonly root: string) {}

  /** Snapshot `target` (file or directory) and register its restoration. */
  async guard(target: string): Promise<void> {
    const snapshot = path.join(this.root, String(this.counter++))
    let existed = false
    try {
      const stats = await fs.lstat(target)
      existed = true
      await fs.mkdir(path.dirname(snapshot), { recursive: true })
      if (stats.isDirectory()) {
        await fs.cp(target, snapshot, { recursive: true })
      } else {
        await fs.copyFile(target, snapshot)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.undo.push(async () => {
      if (existed) {
        await atomicReplace(snapshot, target)
      } else {
        await fs.rm(target, { recursive: true, force: true })
      }
    })
  }

  async rollback(): Promise<string[]> {
    const failures: string[] = []
    for (const step of [...this.undo].reverse()) {
      try {
        await step()
      } catch (error) {
        failures.push((error as Error).message)
      }
    }
    return failures
  }
}

export async function previewMarketplaceBundle(
  cwd: string,
  config: MarketplaceProviderConfig,
  artifact: Extract<MarketplaceArtifact, { kind: 'bundle' }>,
): Promise<MarketplaceBundlePreview> {
  const lock = await readMarketplaceLock(cwd)
  const key = entryKey(
    artifact.item.providerId,
    artifact.kind,
    artifact.item.externalId,
  )
  const previous = lock.entries.find(
    entry => entryKey(entry.providerId, entry.kind, entry.externalId) === key,
  )
  const tempRoot = path.join(
    cwd,
    getAppDirName(),
    '.marketplace-tmp',
    crypto.randomUUID(),
  )
  await fs.mkdir(tempRoot, { recursive: true })
  try {
    const materialized = await materializeBundle(artifact, tempRoot, config)
    const deployFiles = await bundleDeploymentFiles(
      materialized.root,
      materialized.files,
    )
    const files = await bundleFileStates(
      cwd,
      materialized.files,
      deployFiles,
      previous,
    )
    for (const old of previous?.files ?? []) {
      if (deployFiles.some(file => file.targetPath === old.path)) continue
      const oldPath = path.join(cwd, old.path)
      const [exists, currentHash] = await Promise.all([
        pathExists(oldPath),
        pathHash(oldPath),
      ])
      if (exists && currentHash !== old.hash) {
        files.push({
          sourcePath: old.path,
          targetPath: old.path,
          size: 0,
          state: 'modified',
        })
      }
    }
    const warnings = [...(artifact.item.warnings ?? [])]
    const archiveOnly = materialized.files.length - deployFiles.length
    if (deployFiles.length === 0) {
      warnings.push(
        'No supported BaiX resources were found. This bundle cannot be installed.',
      )
    } else if (artifact.item.platformType !== 'baix') {
      warnings.push(
        `${deployFiles.length} file(s) will be converted to BaiX paths under ${getAppDirName()}.`,
      )
    }
    if (archiveOnly > 0) {
      warnings.push(
        `${archiveOnly} unsupported file(s) will be kept in the bundle archive but not deployed to the workspace.`,
      )
    }
    const blocked = files.filter(
      file => file.state === 'conflict' || file.state === 'modified',
    )
    if (blocked.length > 0) {
      warnings.push(
        `${blocked.length} workspace file(s) conflict or were modified locally. Confirm installation to replace them; backups will be restored when the bundle is uninstalled.`,
      )
    }
    return {
      name: safeBundleName(artifact.item.name),
      platformType: artifact.item.platformType,
      files,
      warnings,
      canInstall: deployFiles.length > 0,
      requiresConfirmation: blocked.length > 0,
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function installMarketplaceArtifact(
  cwd: string,
  config: MarketplaceProviderConfig,
  artifact: MarketplaceArtifact,
  options: { confirmBundleConflicts?: boolean } = {},
): Promise<LockEntry> {
  return withWorkspaceLock(cwd, () =>
    installMarketplaceArtifactLocked(cwd, config, artifact, options),
  )
}

async function installMarketplaceArtifactLocked(
  cwd: string,
  config: MarketplaceProviderConfig,
  artifact: MarketplaceArtifact,
  options: { confirmBundleConflicts?: boolean },
): Promise<LockEntry> {
  const lock = await loadMarketplaceLock(cwd, { strict: true })
  const key = entryKey(
    artifact.item.providerId,
    artifact.kind,
    artifact.item.externalId,
  )
  const previous = lock.entries.find(
    entry => entryKey(entry.providerId, entry.kind, entry.externalId) === key,
  )
  const tempRoot = path.join(
    cwd,
    getAppDirName(),
    '.marketplace-tmp',
    crypto.randomUUID(),
  )
  await fs.mkdir(tempRoot, { recursive: true })
  // Every workspace mutation below is journaled so a mid-install failure
  // (disk full, permissions, lock write error) restores the previous state
  // instead of leaving a half-installed bundle with a stale lock.
  const journal = new InstallJournal(path.join(tempRoot, 'journal'))
  // Stale paths from older layouts; removed only after the lock is committed.
  const staleAfterCommit: string[] = []
  try {
    let name: string
    let hash: string
    let destination: string
    let managedFiles:
      Array<{ path: string; hash: string; backupPath?: string }> | undefined
    if (artifact.kind === 'skill') {
      const skillRoot = await materializeSkill(artifact, tempRoot, config)
      ;({ name, hash } = await validateStandardSkill(skillRoot))
      destination = path.join(cwd, getAppDirName(), 'skills', name)
      const relative = path.relative(cwd, destination)
      if (
        !previous &&
        lock.entries.some(
          entry => entry.kind === 'skill' && entry.path === relative,
        )
      ) {
        throw new MarketplaceError(
          `Another marketplace item already owns skill '${name}'`,
          409,
        )
      }
      try {
        await fs.access(destination)
        if (!previous || previous.path !== relative) {
          throw new MarketplaceError(
            `Local skill '${name}' already exists and is not managed by this item`,
            409,
          )
        }
      } catch (error) {
        if (
          error instanceof MarketplaceError ||
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error
        }
      }
      await journal.guard(destination)
      await atomicReplace(skillRoot, destination)
      // Marketplace skills were briefly installed to the cross-client
      // `.agents/skills` path. Remove that old owned copy after a successful
      // update so the lock and filesystem converge on this app's extension
      // root without deleting arbitrary paths from a tampered lock file.
      const legacyRelative = path.join('.agents', 'skills', name)
      if (previous?.path === legacyRelative && previous.path !== relative) {
        staleAfterCommit.push(path.join(cwd, legacyRelative))
      }
    } else if (artifact.kind === 'agent') {
      const provisional = path.join(tempRoot, 'agent.md')
      ;({ name, hash } = validateAgent(artifact.contents, provisional))
      destination = path.join(cwd, getAppDirName(), 'agents', `${name}.md`)
      const relative = path.relative(cwd, destination)
      try {
        await fs.access(destination)
        if (!previous || previous.path !== relative) {
          throw new MarketplaceError(
            `Local agent '${name}' already exists and is not managed by this item`,
            409,
          )
        }
      } catch (error) {
        if (
          error instanceof MarketplaceError ||
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error
        }
      }
      await fs.writeFile(provisional, artifact.contents, 'utf8')
      await journal.guard(destination)
      await atomicReplace(provisional, destination)
    } else {
      const materialized = await materializeBundle(artifact, tempRoot, config)
      const deployFiles = await bundleDeploymentFiles(
        materialized.root,
        materialized.files,
      )
      if (deployFiles.length === 0) {
        throw new MarketplaceError(
          'AI Bundle contains no resources that can be converted to BaiX',
          400,
        )
      }
      name = safeBundleName(artifact.item.name)
      const states = await bundleFileStates(
        cwd,
        materialized.files,
        deployFiles,
        previous,
      )
      const blocked = states.filter(
        file => file.state === 'conflict' || file.state === 'modified',
      )
      for (const old of previous?.files ?? []) {
        if (deployFiles.some(file => file.targetPath === old.path)) continue
        const oldPath = path.join(cwd, old.path)
        const [exists, currentHash] = await Promise.all([
          pathExists(oldPath),
          pathHash(oldPath),
        ])
        if (exists && currentHash !== old.hash) {
          blocked.push({
            sourcePath: old.path,
            targetPath: old.path,
            size: 0,
            state: 'modified',
          })
        }
      }
      if (blocked.length > 0 && !options.confirmBundleConflicts) {
        throw new MarketplaceError(
          `AI Bundle conflicts with workspace files: ${blocked
            .slice(0, 5)
            .map(file => file.targetPath ?? file.sourcePath)
            .join(', ')}`,
          409,
        )
      }

      destination = path.join(cwd, getAppDirName(), 'bundles', name)
      const relative = path.relative(cwd, destination)
      try {
        await fs.access(destination)
        if (!previous || previous.path !== relative) {
          throw new MarketplaceError(
            `Local AI Bundle storage '${name}' already exists and is not managed by this item`,
            409,
          )
        }
      } catch (error) {
        if (
          error instanceof MarketplaceError ||
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error
        }
      }

      const backupRoot = bundleBackupRoot(
        cwd,
        artifact.item.providerId,
        artifact.item.externalId,
      )
      managedFiles = []
      for (const file of deployFiles) {
        const state = states.find(item => item.sourcePath === file.path)?.state
        const prior = previous?.files?.find(
          item => item.path === file.targetPath,
        )
        let backupPath = prior?.backupPath
        if (backupPath) {
          resolveBundleBackup(
            cwd,
            artifact.item.providerId,
            artifact.item.externalId,
            backupPath,
          )
        }
        if (state === 'conflict' || state === 'modified') {
          const backup = path.join(
            backupRoot,
            `${crypto
              .createHash('sha256')
              .update(file.targetPath)
              .digest('hex')}.backup`,
          )
          await journal.guard(backup)
          await atomicReplace(path.join(cwd, file.targetPath), backup)
          backupPath = path.relative(cwd, backup)
        }
        managedFiles.push({
          path: file.targetPath,
          hash: file.hash,
          ...(backupPath ? { backupPath } : {}),
        })
      }

      for (const [index, file] of deployFiles.entries()) {
        const converted = path.join(tempRoot, 'converted', String(index))
        await fs.mkdir(path.dirname(converted), { recursive: true })
        await fs.writeFile(converted, file.contents)
        const target = path.join(cwd, file.targetPath)
        await journal.guard(target)
        await atomicReplace(converted, target)
      }
      for (const old of previous?.files ?? []) {
        if (deployFiles.some(file => file.targetPath === old.path)) continue
        const oldDestination = path.join(cwd, old.path)
        const oldBackup = old.backupPath
          ? resolveBundleBackup(
              cwd,
              artifact.item.providerId,
              artifact.item.externalId,
              old.backupPath,
            )
          : undefined
        const currentHash = await pathHash(oldDestination)
        if (currentHash === old.hash) {
          await journal.guard(oldDestination)
          if (oldBackup && (await pathExists(oldBackup))) {
            await atomicReplace(oldBackup, oldDestination)
          } else {
            await fs.rm(oldDestination, { force: true })
          }
        }
        if (oldBackup) {
          await journal.guard(oldBackup)
          await fs.rm(oldBackup, { recursive: true, force: true })
        }
      }
      await journal.guard(destination)
      await atomicReplace(materialized.root, destination)
      if (
        previous?.kind === 'bundle' &&
        previous.path !== relative &&
        expectedEntryPaths(previous).includes(previous.path)
      ) {
        staleAfterCommit.push(path.join(cwd, previous.path))
      }
      hash = crypto
        .createHash('sha256')
        .update(
          materialized.files
            .map(file => `${file.path}\0${file.hash}`)
            .sort()
            .join('\0'),
        )
        .digest('hex')
    }

    const entry: LockEntry = {
      providerId: artifact.item.providerId,
      externalId: artifact.item.externalId,
      kind: artifact.kind,
      name,
      version: artifact.item.version,
      hash: artifact.item.hash ?? hash,
      path: path.relative(cwd, destination),
      installedAt: new Date().toISOString(),
      ...(managedFiles ? { files: managedFiles } : {}),
    }
    lock.entries = lock.entries.filter(
      candidate =>
        entryKey(candidate.providerId, candidate.kind, candidate.externalId) !==
        key,
    )
    lock.entries.push(entry)
    // Invalidate extension snapshots before committing the lock. An extra
    // generation on a later lock-write failure is harmless; the reverse
    // ordering could commit an install without notifying cloud runtimes.
    await bumpUserConfigGeneration(path.join(cwd, getAppDirName()))
    await writeMarketplaceLock(cwd, lock)
    // Committed. Old-layout leftovers are best-effort cleanup from here on.
    for (const stale of staleAfterCommit) {
      await fs.rm(stale, { recursive: true, force: true }).catch(() => {})
    }
    return entry
  } catch (error) {
    const failures = await journal.rollback()
    if (failures.length > 0) {
      const message = error instanceof Error ? error.message : String(error)
      throw new MarketplaceError(
        `${message} (rollback incomplete: ${failures.join('; ')})`,
        500,
      )
    }
    throw error
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function uninstallMarketplaceArtifact(
  cwd: string,
  providerId: string,
  kind: MarketplaceKind,
  externalId: string,
): Promise<LockEntry> {
  return withWorkspaceLock(cwd, () =>
    uninstallMarketplaceArtifactLocked(cwd, providerId, kind, externalId),
  )
}

async function uninstallMarketplaceArtifactLocked(
  cwd: string,
  providerId: string,
  kind: MarketplaceKind,
  externalId: string,
): Promise<LockEntry> {
  const lock = await loadMarketplaceLock(cwd, { strict: true })
  const key = entryKey(providerId, kind, externalId)
  const entry = lock.entries.find(
    candidate =>
      entryKey(candidate.providerId, candidate.kind, candidate.externalId) ===
      key,
  )
  if (!entry) {
    throw new MarketplaceError('Marketplace item is not installed', 404)
  }
  if (!expectedEntryPaths(entry).includes(entry.path)) {
    throw new MarketplaceError('Installed marketplace path is invalid', 409)
  }

  // Bump before destructive work so a generation-write failure cannot leave a
  // completed uninstall invisible to runtime caches.
  await bumpUserConfigGeneration(path.join(cwd, getAppDirName()))

  if (entry.kind === 'bundle') {
    for (const file of entry.files ?? []) {
      const destination = path.join(cwd, assertBundleTargetPath(file.path))
      const currentHash = await pathHash(destination)
      if (currentHash === file.hash) {
        const backup = file.backupPath
          ? resolveBundleBackup(
              cwd,
              entry.providerId,
              entry.externalId,
              file.backupPath,
            )
          : undefined
        if (backup && (await pathExists(backup))) {
          await atomicReplace(backup, destination)
        } else {
          await fs.rm(destination, { force: true })
          await removeEmptyParents(path.dirname(destination), cwd)
        }
      }
    }
    await fs.rm(bundleBackupRoot(cwd, entry.providerId, entry.externalId), {
      recursive: true,
      force: true,
    })
  }
  await fs.rm(path.join(cwd, entry.path), {
    recursive: entry.kind !== 'agent',
    force: true,
  })
  lock.entries = lock.entries.filter(
    candidate =>
      entryKey(candidate.providerId, candidate.kind, candidate.externalId) !==
      key,
  )
  await writeMarketplaceLock(cwd, lock)
  return entry
}

async function removeEmptyParents(
  directory: string,
  stop: string,
): Promise<void> {
  let current = path.resolve(directory)
  const root = path.resolve(stop)
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await fs.rmdir(current)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' ||
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
    current = path.dirname(current)
  }
}

export function decorateInstallState(
  item: MarketplaceItem,
  lock: MarketplaceLock,
  localNames: { skills: Set<string>; agents: Set<string> },
): MarketplaceItem {
  const owned = lock.entries.find(
    entry =>
      entry.providerId === item.providerId &&
      entry.kind === item.kind &&
      entry.externalId === item.externalId,
  )
  if (owned) {
    const changed =
      (item.hash && owned.hash && item.hash !== owned.hash) ||
      (item.version && owned.version && item.version !== owned.version)
    return {
      ...item,
      installState: changed ? 'updateAvailable' : 'installed',
      localVersion: owned.version,
    }
  }
  const exists =
    item.kind === 'skill'
      ? localNames.skills.has(item.name)
      : item.kind === 'agent'
        ? localNames.agents.has(item.name)
        : false
  return { ...item, installState: exists ? 'conflict' : 'available' }
}
