import { promises as fs } from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { getUserAppDir } from '../utils/app-dir.js'

export const USER_CONFIG_GENERATION_FILE = '.config-generation'

const generationQueues = new Map<string, Promise<unknown>>()
const memoryGenerations = new Map<string, number>()

function normalizedRoot(appDir: string): string {
  return path.resolve(appDir)
}

function generationPath(appDir: string): string {
  return path.join(normalizedRoot(appDir), USER_CONFIG_GENERATION_FILE)
}

async function readPersistedGeneration(appDir: string): Promise<number> {
  try {
    const rootStats = await fs.lstat(normalizedRoot(appDir))
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error('User config root is not a regular directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }

  const filePath = generationPath(appDir)
  try {
    const stats = await fs.lstat(filePath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('User config generation path is not a regular file')
    }
    const raw = await fs.readFile(filePath, 'utf8')
    const value = /^\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : 0
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/**
 * Read the generation for one user's extension configuration.
 *
 * The optional root makes this usable by cloud runtimes that already carry a
 * pinned agent home. Callers in a request scope can omit it.
 */
export async function getUserConfigGeneration(
  appDir = getUserAppDir(),
): Promise<number> {
  const root = normalizedRoot(appDir)
  const persisted = await readPersistedGeneration(root)
  return Math.max(persisted, memoryGenerations.get(root) ?? 0)
}

async function bumpUnlocked(appDir: string): Promise<number> {
  const root = normalizedRoot(appDir)
  await fs.mkdir(root, { recursive: true })
  const rootStats = await fs.lstat(root)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('User config root is not a regular directory')
  }

  const current = await getUserConfigGeneration(root)
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('User config generation counter is exhausted')
  }
  const next = current + 1
  const destination = generationPath(root)
  const temp = path.join(
    root,
    `.${USER_CONFIG_GENERATION_FILE}.${crypto.randomUUID()}.tmp`,
  )
  try {
    await fs.writeFile(temp, `${next}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, destination)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
  memoryGenerations.set(root, next)
  return next
}

/**
 * Atomically increment one user's config generation.
 *
 * Calls are serialized per root so simultaneous HTTP mutations cannot lose an
 * increment. The counter is a tiny file rather than database state, allowing a
 * later cloud runtime to compare it before rebuilding extension snapshots.
 */
export function bumpUserConfigGeneration(
  appDir = getUserAppDir(),
): Promise<number> {
  const root = normalizedRoot(appDir)
  const previous = generationQueues.get(root) ?? Promise.resolve()
  const run = previous.then(
    () => bumpUnlocked(root),
    () => bumpUnlocked(root),
  )
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  generationQueues.set(root, settled)
  return run.finally(() => {
    if (generationQueues.get(root) === settled) generationQueues.delete(root)
  })
}

/** Semantic alias for cache invalidation call sites such as Marketplace. */
export const invalidateUserConfig = bumpUserConfigGeneration
