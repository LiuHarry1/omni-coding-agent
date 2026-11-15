/**
 * Plan file management.
 *
 * Default: `{agentHome}/.ai-agent/plans/{slug}.md` (NOT the project cwd).
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { Session } from '../core/types.js'
import { getAppDirName } from './app-dir.js'
import { resolveAgentHome } from './workspace/request-scope.js'

const ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'eager',
  'gentle',
  'happy',
  'keen',
  'lucky',
  'nimble',
  'proud',
  'quick',
  'sharp',
  'steady',
  'swift',
  'witty',
] as const

const NOUNS = [
  'badger',
  'beacon',
  'cedar',
  'comet',
  'falcon',
  'harbor',
  'maple',
  'meadow',
  'otter',
  'panda',
  'river',
  'sparrow',
  'tiger',
  'willow',
] as const

function pick<T extends readonly string[]>(arr: T): string {
  return arr[randomBytes(1)[0]! % arr.length]!
}

function generateWordSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}

/** Default home plans root: `~/.ai-agent/plans`. */
export function getDefaultPlansDirectory(): string {
  return path.join(resolveAgentHome(), getAppDirName(), 'plans')
}

export function getPlansDirectory(): string {
  const plansPath = getDefaultPlansDirectory()
  fs.mkdirSync(plansPath, { recursive: true })
  return plansPath
}

export function ensurePlanSlug(session: Session): string {
  if (session.permissionMode.planSlug) {
    return session.permissionMode.planSlug
  }

  const plansDir = getPlansDirectory()
  let slug = generateWordSlug()
  let attempts = 0
  while (fs.existsSync(path.join(plansDir, `${slug}.md`)) && attempts < 10) {
    slug = generateWordSlug()
    attempts++
  }

  session.permissionMode = {
    ...session.permissionMode,
    planSlug: slug,
  }
  return slug
}

export function getPlanFilePath(session: Session, _cwd?: string): string {
  const slug = ensurePlanSlug(session)
  return path.join(getPlansDirectory(), `${slug}.md`)
}

export function isSessionPlanFile(
  absolutePath: string,
  session: Session,
  _cwd?: string,
): boolean {
  if (!session.permissionMode.planSlug) return false
  const expected = path.resolve(getPlanFilePath(session))
  const normalized = path.resolve(absolutePath)
  return normalized === expected && normalized.endsWith('.md')
}

export function getPlan(session: Session, _cwd?: string): string | null {
  const filePath = getPlanFilePath(session)
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function planExists(session: Session, _cwd?: string): boolean {
  return getPlan(session) !== null
}

export function writePlan(
  session: Session,
  _cwd: string | undefined,
  content: string,
): string {
  const filePath = getPlanFilePath(session)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function clearPlanSlug(session: Session): void {
  session.permissionMode = { ...session.permissionMode, planSlug: undefined }
}
