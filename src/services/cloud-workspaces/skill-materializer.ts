import { constants as fsConstants, promises as fs } from 'fs'
import { createHash, randomBytes } from 'crypto'
import * as path from 'path'
import type { Readable } from 'stream'
import { isValidWorkspaceId } from '../../execution/providers/cloud/containers.js'
import {
  ShellFsPort,
  shQuote,
  type ShellResult,
} from '../../execution/shell-fs.js'
import type { SkillDefinition } from '../../skills/types.js'
import { SKILL_PACKAGE_POLICY } from '../../skills/package-policy.js'
import { getUserConfigGeneration } from '../user-config-generation.js'

export const DEFAULT_CLOUD_SKILL_LIMITS = SKILL_PACKAGE_POLICY

const MAX_METADATA_CACHE_ENTRIES = 128

type CachedMaterialization = {
  manifestHash: string
  snapshotRoot: string
  runtimeBaseDirs: ReadonlyArray<readonly [string, string]>
  skipped: ReadonlyArray<SkippedCloudSkill>
}

const metadataCache = new Map<string, CachedMaterialization>()
const materializationsInFlight = new Map<
  string,
  Promise<CloudSkillMaterialization>
>()

export type CloudSkillLimits = {
  maxFiles: number
  maxDirectories: number
  maxSingleFileBytes: number
  maxTotalBytes: number
}

export class CloudSkillPackageLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudSkillPackageLimitError'
  }
}

export interface CloudSkillMaterializationPort {
  run(
    script: string,
    opts?: { input?: Buffer | Readable; timeoutMs?: number },
  ): Promise<ShellResult>
  mkdir(dirPath: string): Promise<void>
  writeFile(
    filePath: string,
    data: Buffer | Readable,
    opts?: { exclusive?: boolean; timeoutMs?: number },
  ): Promise<void>
  remove(targetPath: string): Promise<void>
}

export type CloudSkillMaterialization = {
  manifestHash: string | null
  snapshotRoot: string | null
  copied: boolean
  skills: SkillDefinition[]
  /** Host package identity → immutable container package directory. */
  runtimeBaseDirs: ReadonlyMap<string, string>
  /** Invalid pre-existing packages omitted from this turn. */
  skipped: SkippedCloudSkill[]
}

export type SkippedCloudSkill = {
  name: string
  error: string
}

type PackageFile = {
  relativePath: string
  content: Buffer
  mode: number
}

type SkillPackage = {
  skill: SkillDefinition
  directories: string[]
  files: PackageFile[]
}

export type MaterializeCloudSkillsOptions = {
  workspaceId: string
  skills: readonly SkillDefinition[]
  port: CloudSkillMaterializationPort
  /** Optional canonical boundary for every host package. */
  sourceRoot?: string
  /** Test override; production defaults to a workspace-specific `/tmp` root. */
  sessionRoot?: string
  limits?: Partial<CloudSkillLimits>
}

function packageKey(skill: SkillDefinition): string | null {
  if (!skill.baseDir) return null
  return `${skill.name}\0${path.resolve(skill.baseDir)}`
}

function sortedSkillsAndIdentities(skills: readonly SkillDefinition[]): {
  sortedSkills: SkillDefinition[]
  identities: string[]
} {
  const sortedSkills = [...skills].sort((a, b) => {
    const byName = a.name.localeCompare(b.name)
    if (byName !== 0) return byName
    return (a.baseDir ?? '').localeCompare(b.baseDir ?? '')
  })
  const names = new Set<string>()
  const identities: string[] = []
  for (const skill of sortedSkills) {
    if (names.has(skill.name)) {
      throw new Error(`Duplicate cloud skill package name: ${skill.name}`)
    }
    names.add(skill.name)
    const key = packageKey(skill)
    if (key) identities.push(`${skill.source}\0${key}`)
  }
  return { sortedSkills, identities }
}

export function mapMaterializedSkills(
  skills: readonly SkillDefinition[],
  runtimeBaseDirs: ReadonlyMap<string, string>,
): SkillDefinition[] {
  return skills.map(skill => {
    const key = packageKey(skill)
    const runtimeBaseDir = key ? runtimeBaseDirs.get(key) : undefined
    return runtimeBaseDir ? { ...skill, runtimeBaseDir } : skill
  })
}

function usableSkills(
  skills: readonly SkillDefinition[],
  runtimeBaseDirs: ReadonlyMap<string, string>,
  skipped: readonly SkippedCloudSkill[],
): SkillDefinition[] {
  const skippedNames = new Set(skipped.map(item => item.name))
  return mapMaterializedSkills(
    skills.filter(skill => !skippedNames.has(skill.name)),
    runtimeBaseDirs,
  )
}

function cachedResult(
  skills: readonly SkillDefinition[],
  cached: CachedMaterialization,
): CloudSkillMaterialization {
  const runtimeBaseDirs = new Map(cached.runtimeBaseDirs)
  const skipped = cached.skipped.map(item => ({ ...item }))
  return {
    manifestHash: cached.manifestHash,
    snapshotRoot: cached.snapshotRoot,
    copied: false,
    skills: usableSkills(skills, runtimeBaseDirs, skipped),
    runtimeBaseDirs,
    skipped,
  }
}

function resultForWaitingCaller(
  skills: readonly SkillDefinition[],
  result: CloudSkillMaterialization,
): CloudSkillMaterialization {
  const runtimeBaseDirs = new Map(result.runtimeBaseDirs)
  const skipped = result.skipped.map(item => ({ ...item }))
  return {
    ...result,
    copied: false,
    skills: usableSkills(skills, runtimeBaseDirs, skipped),
    runtimeBaseDirs,
    skipped,
  }
}

function rememberMetadata(
  key: string,
  result: CloudSkillMaterialization,
): void {
  if (!result.manifestHash || !result.snapshotRoot) return
  const cached: CachedMaterialization = {
    manifestHash: result.manifestHash,
    snapshotRoot: result.snapshotRoot,
    runtimeBaseDirs: [...result.runtimeBaseDirs.entries()],
    skipped: result.skipped.map(item => ({ ...item })),
  }
  metadataCache.delete(key)
  metadataCache.set(key, cached)
  while (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
    const oldest = metadataCache.keys().next().value as string | undefined
    if (!oldest) break
    metadataCache.delete(oldest)
  }
}

function touchMetadata(key: string, cached: CachedMaterialization): void {
  metadataCache.delete(key)
  metadataCache.set(key, cached)
}

export function resetCloudSkillMaterializationCacheForTesting(): void {
  metadataCache.clear()
  materializationsInFlight.clear()
}

export function canMapMaterializedSkills(
  skills: readonly SkillDefinition[],
  runtimeBaseDirs: ReadonlyMap<string, string>,
): boolean {
  return skills.every(skill => {
    const key = packageKey(skill)
    return key === null || runtimeBaseDirs.has(key)
  })
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid cloud skill limit ${name}: ${value}`)
  }
  return value
}

function resolveLimits(
  overrides: Partial<CloudSkillLimits> | undefined,
): CloudSkillLimits {
  const merged = { ...DEFAULT_CLOUD_SKILL_LIMITS, ...overrides }
  return {
    maxFiles: positiveLimit(merged.maxFiles, 'maxFiles'),
    maxDirectories: positiveLimit(merged.maxDirectories, 'maxDirectories'),
    maxSingleFileBytes: positiveLimit(
      merged.maxSingleFileBytes,
      'maxSingleFileBytes',
    ),
    maxTotalBytes: positiveLimit(merged.maxTotalBytes, 'maxTotalBytes'),
  }
}

function normalizedSessionRoot(options: MaterializeCloudSkillsOptions): string {
  const sessionRoot =
    options.sessionRoot ?? `/tmp/baize-extension-session-${options.workspaceId}`
  const normalized = path.posix.normalize(sessionRoot)
  if (!path.posix.isAbsolute(normalized) || normalized === '/') {
    throw new Error(`Cloud skill session root must be absolute: ${sessionRoot}`)
  }
  return normalized
}

function metadataCacheKey(input: {
  sourceRoot: string
  workspaceId: string
  generation: number
  identities: readonly string[]
  sessionRoot: string
  limits: CloudSkillLimits
}): string {
  return createHash('sha256')
    .update('baize-cloud-skill-metadata-v1\0')
    .update(input.sourceRoot)
    .update('\0')
    .update(input.workspaceId)
    .update('\0')
    .update(String(input.generation))
    .update('\0')
    .update(JSON.stringify(input.identities))
    .update('\0')
    .update(input.sessionRoot)
    .update('\0')
    .update(JSON.stringify(input.limits))
    .digest('hex')
}

async function readRegularFile(
  filePath: string,
  before: Awaited<ReturnType<typeof fs.lstat>>,
  limits: CloudSkillLimits,
): Promise<{ content: Buffer; mode: number }> {
  if (before.size > limits.maxSingleFileBytes) {
    throw new CloudSkillPackageLimitError(
      `Skill package file exceeds ${limits.maxSingleFileBytes} bytes: ${filePath}`,
    )
  }

  const noFollow =
    typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`Skill package file changed while scanning: ${filePath}`)
    }
    if (opened.size > limits.maxSingleFileBytes) {
      throw new CloudSkillPackageLimitError(
        `Skill package file exceeds ${limits.maxSingleFileBytes} bytes: ${filePath}`,
      )
    }
    const content = await handle.readFile()
    if (content.byteLength !== opened.size) {
      throw new Error(`Skill package file changed while reading: ${filePath}`)
    }
    return { content, mode: opened.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

async function collectPackage(
  skill: SkillDefinition,
  limits: CloudSkillLimits,
  totals: { files: number; directories: number; bytes: number },
  sourceBoundary?: { lexical: string; canonical: string },
): Promise<SkillPackage | null> {
  if (!skill.baseDir) return null
  const sourceDir = path.resolve(skill.baseDir)
  if (sourceBoundary) {
    const lexicalRelative = path.relative(sourceBoundary.lexical, sourceDir)
    if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
      throw new Error(
        `Skill package escapes the allowed source root: ${sourceDir}`,
      )
    }
    let cursor = sourceBoundary.lexical
    for (const component of lexicalRelative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component)
      if ((await fs.lstat(cursor)).isSymbolicLink()) {
        throw new Error(`Symlink rejected in skill package path: ${cursor}`)
      }
    }
  }
  const rootStat = await fs.lstat(sourceDir)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `Skill package root must be a regular directory: ${sourceDir}`,
    )
  }
  if (sourceBoundary) {
    const canonicalSource = await fs.realpath(sourceDir)
    const relative = path.relative(sourceBoundary.canonical, canonicalSource)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Skill package escapes the allowed source root: ${sourceDir}`,
      )
    }
  }

  const directories: string[] = []
  const files: PackageFile[] = []
  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    const beforeDirectory = await fs.lstat(dir)
    if (beforeDirectory.isSymbolicLink() || !beforeDirectory.isDirectory()) {
      throw new Error(`Skill package directory changed while scanning: ${dir}`)
    }
    const entries = await fs.readdir(dir)
    entries.sort((a, b) => a.localeCompare(b))
    for (const name of entries) {
      const filePath = path.join(dir, name)
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, name)
        : name
      const stat = await fs.lstat(filePath)
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink rejected in skill package: ${filePath}`)
      }
      if (stat.isDirectory()) {
        totals.directories++
        if (totals.directories > limits.maxDirectories) {
          throw new CloudSkillPackageLimitError(
            `Skill packages exceed ${limits.maxDirectories} directories`,
          )
        }
        directories.push(relativePath)
        await walk(filePath, relativePath)
        continue
      }
      if (!stat.isFile()) {
        throw new Error(`Special file rejected in skill package: ${filePath}`)
      }

      totals.files++
      if (totals.files > limits.maxFiles) {
        throw new CloudSkillPackageLimitError(
          `Skill packages exceed ${limits.maxFiles} files`,
        )
      }
      const regular = await readRegularFile(filePath, stat, limits)
      totals.bytes += regular.content.byteLength
      if (totals.bytes > limits.maxTotalBytes) {
        throw new CloudSkillPackageLimitError(
          `Skill packages exceed ${limits.maxTotalBytes} total bytes`,
        )
      }
      files.push({ relativePath, ...regular })
    }
    const afterDirectory = await fs.lstat(dir)
    if (
      !afterDirectory.isDirectory() ||
      afterDirectory.dev !== beforeDirectory.dev ||
      afterDirectory.ino !== beforeDirectory.ino
    ) {
      throw new Error(`Skill package directory changed while scanning: ${dir}`)
    }
  }

  await walk(sourceDir, '')
  return { skill, directories, files }
}

function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value)
  hash.update(String(bytes.byteLength))
  hash.update(':')
  hash.update(bytes)
  hash.update('\0')
}

function hashPackages(packages: readonly SkillPackage[]): string {
  const hash = createHash('sha256')
  hash.update('baize-cloud-skill-packages-v1\0')
  for (const pkg of packages) {
    hashField(hash, pkg.skill.name)
    for (const dir of pkg.directories) {
      hash.update('d\0')
      hashField(hash, dir)
    }
    for (const file of pkg.files) {
      hash.update('f\0')
      hashField(hash, file.relativePath)
      hashField(hash, file.mode.toString(8))
      hashField(hash, String(file.content.byteLength))
      hash.update(file.content)
      hash.update('\0')
    }
  }
  return hash.digest('hex')
}

async function runChecked(
  port: CloudSkillMaterializationPort,
  script: string,
  action: string,
): Promise<Buffer> {
  const result = await port.run(script)
  if (result.code === 0) return result.stdout
  throw new Error(
    `${action} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
  )
}

async function ensureSessionRoot(
  port: CloudSkillMaterializationPort,
  root: string,
): Promise<void> {
  await runChecked(
    port,
    `
set -eu
root=${shQuote(root)}
if [ -L "$root" ] || { [ -e "$root" ] && [ ! -d "$root" ]; }; then
  echo "unsafe cloud skill session root" >&2
  exit 3
fi
umask 077
mkdir -p "$root"
chmod 700 "$root"
`,
    'Preparing cloud skill session root',
  )
}

async function snapshotReady(
  port: CloudSkillMaterializationPort,
  root: string,
  hash: string,
): Promise<boolean> {
  const marker = path.posix.join(root, '.complete')
  const result = await port.run(`
root=${shQuote(root)}
marker=${shQuote(marker)}
[ -d "$root" ] && [ ! -L "$root" ] &&
  [ -f "$marker" ] && [ ! -L "$marker" ] &&
  [ "$(cat "$marker")" = ${shQuote(hash)} ]
`)
  return result.code === 0
}

async function applyModes(
  port: CloudSkillMaterializationPort,
  files: readonly { path: string; mode: number }[],
): Promise<void> {
  const batchSize = 100
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = files.slice(offset, offset + batchSize)
    const commands = batch
      .map(file => `chmod ${file.mode.toString(8)} ${shQuote(file.path)}`)
      .join('\n')
    await runChecked(port, `set -eu\n${commands}\n`, 'Setting skill file modes')
  }
}

async function publishSnapshot(
  port: CloudSkillMaterializationPort,
  stage: string,
  destination: string,
  hash: string,
): Promise<void> {
  const marker = path.posix.join(destination, '.complete')
  await runChecked(
    port,
    `
set -eu
stage=${shQuote(stage)}
destination=${shQuote(destination)}
marker=${shQuote(marker)}
if [ -L "$destination" ]; then
  echo "cloud skill snapshot destination is a symlink" >&2
  exit 3
fi
if [ -e "$destination" ]; then
  if [ -d "$destination" ] && [ -f "$marker" ] && [ ! -L "$marker" ] &&
     [ "$(cat "$marker")" = ${shQuote(hash)} ]; then
    rm -rf "$stage"
  else
    echo "cloud skill snapshot destination is incomplete" >&2
    exit 3
  fi
else
  mv "$stage" "$destination"
fi
`,
    'Publishing cloud skill snapshot',
  )
}

/**
 * Copy complete host skill packages into an immutable, content-addressed
 * directory in the current cloud container. Only the returned paths are ever
 * surfaced to a turn; staging directories are removed after any failure.
 */
async function materializeCloudSkillsUncached(
  options: MaterializeCloudSkillsOptions,
): Promise<CloudSkillMaterialization> {
  if (!isValidWorkspaceId(options.workspaceId)) {
    throw new Error(`Invalid cloud workspace id: ${options.workspaceId}`)
  }
  const limits = resolveLimits(options.limits)
  const sourceBoundary = options.sourceRoot
    ? {
        lexical: path.resolve(options.sourceRoot),
        canonical: await fs.realpath(path.resolve(options.sourceRoot)),
      }
    : undefined
  const packages: SkillPackage[] = []
  const skipped: SkippedCloudSkill[] = []
  const { sortedSkills } = sortedSkillsAndIdentities(options.skills)
  for (const skill of sortedSkills) {
    try {
      const pkg = await collectPackage(
        skill,
        limits,
        { files: 0, directories: 0, bytes: 0 },
        sourceBoundary,
      )
      if (pkg) packages.push(pkg)
    } catch (error) {
      if (!(error instanceof CloudSkillPackageLimitError)) throw error
      skipped.push({ name: skill.name, error: error.message })
    }
  }

  if (packages.length === 0) {
    const runtimeBaseDirs = new Map<string, string>()
    return {
      manifestHash: null,
      snapshotRoot: null,
      copied: false,
      skills: usableSkills(options.skills, runtimeBaseDirs, skipped),
      runtimeBaseDirs,
      skipped,
    }
  }

  const manifestHash = hashPackages(packages)
  const normalizedRoot = normalizedSessionRoot(options)
  const snapshotRoot = path.posix.join(normalizedRoot, manifestHash)
  const runtimeBaseDirs = new Map<string, string>()
  for (const pkg of packages) {
    runtimeBaseDirs.set(
      packageKey(pkg.skill)!,
      path.posix.join(snapshotRoot, 'skills', pkg.skill.name),
    )
  }

  await ensureSessionRoot(options.port, normalizedRoot)
  if (await snapshotReady(options.port, snapshotRoot, manifestHash)) {
    return {
      manifestHash,
      snapshotRoot,
      copied: false,
      skills: usableSkills(options.skills, runtimeBaseDirs, skipped),
      runtimeBaseDirs,
      skipped,
    }
  }

  const stage = path.posix.join(
    normalizedRoot,
    `.${manifestHash}.${randomBytes(6).toString('hex')}.staging`,
  )
  try {
    await runChecked(
      options.port,
      `set -eu\numask 077\n[ ! -e ${shQuote(stage)} ]\nmkdir ${shQuote(stage)}\n`,
      'Creating cloud skill staging directory',
    )

    const modeEntries: Array<{ path: string; mode: number }> = []
    for (const pkg of packages) {
      const packageRoot = path.posix.join(stage, 'skills', pkg.skill.name)
      await options.port.mkdir(packageRoot)
      for (const relativeDir of pkg.directories) {
        await options.port.mkdir(path.posix.join(packageRoot, relativeDir))
      }
      for (const file of pkg.files) {
        const destination = path.posix.join(packageRoot, file.relativePath)
        await options.port.writeFile(destination, file.content, {
          exclusive: true,
        })
        modeEntries.push({ path: destination, mode: file.mode })
      }
    }
    await applyModes(options.port, modeEntries)
    await options.port.writeFile(
      path.posix.join(stage, '.complete'),
      Buffer.from(manifestHash),
      { exclusive: true },
    )
    await publishSnapshot(options.port, stage, snapshotRoot, manifestHash)
    if (!(await snapshotReady(options.port, snapshotRoot, manifestHash))) {
      throw new Error('Published cloud skill snapshot failed verification')
    }
  } catch (error) {
    await options.port.remove(stage).catch(() => {})
    throw error
  }

  return {
    manifestHash,
    snapshotRoot,
    copied: true,
    skills: usableSkills(options.skills, runtimeBaseDirs, skipped),
    runtimeBaseDirs,
    skipped,
  }
}

/**
 * Generation-aware entry point. A cache hit performs only the generation read,
 * package-identity comparison, and container marker probe; host packages are
 * not traversed until the generation/identity changes or the marker is gone.
 */
export async function materializeCloudSkills(
  options: MaterializeCloudSkillsOptions,
): Promise<CloudSkillMaterialization> {
  if (!isValidWorkspaceId(options.workspaceId)) {
    throw new Error(`Invalid cloud workspace id: ${options.workspaceId}`)
  }
  const { identities } = sortedSkillsAndIdentities(options.skills)
  if (!options.sourceRoot || identities.length === 0) {
    return materializeCloudSkillsUncached(options)
  }

  const sourceRoot = path.resolve(options.sourceRoot)
  const generation = await getUserConfigGeneration(sourceRoot)
  const key = metadataCacheKey({
    sourceRoot,
    workspaceId: options.workspaceId,
    generation,
    identities,
    sessionRoot: normalizedSessionRoot(options),
    limits: resolveLimits(options.limits),
  })

  const cached = metadataCache.get(key)
  if (
    cached &&
    (await snapshotReady(
      options.port,
      cached.snapshotRoot,
      cached.manifestHash,
    ))
  ) {
    touchMetadata(key, cached)
    return cachedResult(options.skills, cached)
  }

  const pending = materializationsInFlight.get(key)
  if (pending) {
    return resultForWaitingCaller(options.skills, await pending)
  }

  const run = materializeCloudSkillsUncached(options).then(result => {
    // Commit metadata only after the complete marker has been published and
    // verified. A failed newer generation therefore cannot displace an older
    // known-good entry.
    rememberMetadata(key, result)
    return result
  })
  materializationsInFlight.set(key, run)
  try {
    return await run
  } finally {
    if (materializationsInFlight.get(key) === run) {
      materializationsInFlight.delete(key)
    }
  }
}

/** Runtime guard used by the turn pipeline before materialization. */
export function requireShellFsPort(port: unknown): ShellFsPort {
  if (!(port instanceof ShellFsPort)) {
    throw new Error('Cloud workspace has no shell filesystem')
  }
  return port
}
