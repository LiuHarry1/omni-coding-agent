import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import matter from 'gray-matter'
import ignore from 'ignore'
import { normalizeGitPath } from '../core/platform.js'
import { getAppDirName, getUserAppDir } from './app-dir.js'
import {
  getExtensionDir,
  getManagedDir,
  getManagedMemoryEntryPaths,
} from './managed-path.js'
import { getAgentHome } from './request-scope.js'

/**
 * Instructions loader (memory + rules, with managed policy layer).
 *
 *   {managed}/AGENTS.md (+ {managed}/.ai-agent/rules/)  — policy (first)
 *   ~/.ai-agent/AGENTS.md (+ rules/)                    — user
 *   AGENTS.md | {appDir}/AGENTS.md | {appDir}/rules/      — project
 *   AGENTS.local.md                                       — local (highest among project)
 *
 * Walk cwd → git root; closer files load later (higher model priority).
 */

/** Single entry file per directory (repo root or nested package). */
const ENTRY_FILENAMES = ['AGENTS.md']
const LOCAL_ENTRY_FILENAMES = ['AGENTS.local.md']

const MAX_SINGLE_FILE_BYTES = 40 * 1024
const MAX_RULES_BYTES = 40 * 1024
const MAX_INCLUDE_DEPTH = 5
const TEXT_INCLUDE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.sh',
  '.css',
  '.html',
])

interface RuleLoadContext {
  allowedRoot: string
  processedFiles: Set<string>
  visitedDirs: Set<string>
}

function canonicalExistingPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function createRuleLoadContext(allowedRoot: string): RuleLoadContext {
  return {
    allowedRoot:
      canonicalExistingPath(allowedRoot) ?? path.resolve(allowedRoot),
    processedFiles: new Set(),
    visitedDirs: new Set(),
  }
}

function findGitRoot(dir: string): string | null {
  try {
    const raw = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return normalizeGitPath(raw)
  } catch {
    return null
  }
}

function projectCeiling(absDir: string): string {
  const gitRoot = findGitRoot(absDir)
  const authEnabled =
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  if (!authEnabled) return gitRoot || absDir

  const home =
    canonicalExistingPath(getAgentHome()) ?? path.resolve(getAgentHome())
  const candidate = gitRoot
    ? (canonicalExistingPath(gitRoot) ?? path.resolve(gitRoot))
    : absDir
  return isInsideRoot(candidate, home) ? candidate : absDir
}

function isTrustedProjectDir(absDir: string): boolean {
  const authEnabled =
    String(process.env.AUTH_ENABLED ?? '')
      .trim()
      .toLowerCase() === 'true'
  if (!authEnabled) return true
  const home =
    canonicalExistingPath(getAgentHome()) ?? path.resolve(getAgentHome())
  const candidate = canonicalExistingPath(absDir) ?? path.resolve(absDir)
  return isInsideRoot(candidate, home)
}

function findRuleFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

interface RuleSource {
  dir: string
  label: string
  content: string
  filePath?: string
  patterns?: string[]
}

function parsePathsValue(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value.split(/[,\n]/)
      : []
  const patterns = raw.map(item => item.trim()).filter(Boolean)
  return patterns.length > 0 && !patterns.every(pattern => pattern === '**')
    ? patterns
    : undefined
}

function readRulePatterns(absPath: string): string[] | undefined {
  const canonical = canonicalExistingPath(absPath)
  if (!canonical) return undefined
  try {
    return parsePathsValue(
      matter(fs.readFileSync(canonical, 'utf-8')).data.paths,
    )
  } catch {
    return undefined
  }
}

function matchesAnyTarget(
  patterns: string[],
  baseDir: string,
  targetPaths: readonly string[],
): boolean {
  const matcher = ignore().add(patterns)
  return targetPaths.some(targetPath => {
    const relativePath = path
      .relative(baseDir, path.resolve(targetPath))
      .replaceAll(path.sep, '/')
    return (
      relativePath.length > 0 &&
      !relativePath.startsWith('..') &&
      !path.isAbsolute(relativePath) &&
      matcher.ignores(relativePath)
    )
  })
}

function extractIncludePaths(raw: string, parentPath: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = line.match(/^\s*@((?:\\ |[^\s])+)\s*$/)
    if (!match?.[1]) continue
    const requested = match[1].replace(/\\ /g, ' ')
    const resolved = requested.startsWith('~/')
      ? path.resolve(getAgentHome(), requested.slice(2))
      : path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(path.dirname(parentPath), requested)
    if (TEXT_INCLUDE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      out.push(resolved)
    }
  }
  return out
}

function readRuleFile(
  absPath: string,
  context: RuleLoadContext,
  depth = 0,
): string | null {
  if (depth > MAX_INCLUDE_DEPTH) return null
  const canonical = canonicalExistingPath(absPath)
  if (
    !canonical ||
    !isInsideRoot(canonical, context.allowedRoot) ||
    context.processedFiles.has(canonical)
  ) {
    return null
  }
  context.processedFiles.add(canonical)

  try {
    const raw = fs.readFileSync(canonical, 'utf-8').trim()
    if (raw.length === 0) return null
    const body = matter(raw).content.trim()
    if (body.length === 0) return null
    const includes = extractIncludePaths(body, canonical)
      .map(includePath => readRuleFile(includePath, context, depth + 1))
      .filter((content): content is string => content !== null)
    if (Buffer.byteLength(body, 'utf-8') > MAX_SINGLE_FILE_BYTES) {
      const truncated =
        body.slice(0, MAX_SINGLE_FILE_BYTES) +
        '\n\n[...truncated — single rule file exceeded per-file cap]'
      return [truncated, ...includes].join('\n\n')
    }
    return [body, ...includes].join('\n\n')
  } catch {
    return null
  }
}

/** Recursive .md files under a rules directory, sorted by relative path. */
function collectRulesDir(
  projectDir: string,
  rulesDir: string,
  labelPrefix: string,
  context: RuleLoadContext,
  options?: {
    conditional?: boolean
    targetPaths?: readonly string[]
    matchBaseDir?: string
  },
): RuleSource[] {
  const out: RuleSource[] = []
  const walk = (dir: string, relativeDir: string): void => {
    const canonicalDir = canonicalExistingPath(dir)
    if (
      !canonicalDir ||
      !isInsideRoot(canonicalDir, context.allowedRoot) ||
      context.visitedDirs.has(canonicalDir)
    ) {
      return
    }
    context.visitedDirs.add(canonicalDir)

    let entries: fs.Dirent[]
    try {
      entries = fs
        .readdirSync(canonicalDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }

    for (const entry of entries) {
      const abs = path.join(canonicalDir, entry.name)
      const relativeName = path.join(relativeDir, entry.name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(abs, relativeName)
        continue
      }
      if (!stat.isFile() || !/\.md$/i.test(entry.name)) continue
      const patterns = readRulePatterns(abs)
      if (options?.conditional ? !patterns : patterns) continue
      if (
        patterns &&
        !matchesAnyTarget(
          patterns,
          options?.matchBaseDir ?? projectDir,
          options?.targetPaths ?? [],
        )
      ) {
        continue
      }
      const content = readRuleFile(abs, context)
      if (content !== null) {
        out.push({
          dir: projectDir,
          label: `${labelPrefix}/${relativeName.replaceAll(path.sep, '/')}`,
          content,
          filePath: canonicalExistingPath(abs) ?? path.resolve(abs),
          patterns,
        })
      }
    }
  }
  walk(rulesDir, '')
  return out
}

function collectAppDirRules(
  projectDir: string,
  context: RuleLoadContext,
): RuleSource[] {
  const appDir = getAppDirName()
  const out: RuleSource[] = []

  // App-dir AGENTS.md → {appDir}/AGENTS.md
  const nested = findRuleFile(path.join(projectDir, appDir), ENTRY_FILENAMES)
  if (nested) {
    const content = readRuleFile(nested, context)
    if (content !== null) {
      out.push({
        dir: projectDir,
        label: `${appDir}/${path.basename(nested)}`,
        content,
      })
    }
  }

  // Topic rules under {appDir}/rules/
  out.push(
    ...collectRulesDir(
      projectDir,
      path.join(projectDir, appDir, 'rules'),
      `${appDir}/rules`,
      context,
    ),
  )

  // Local overrides (same directory, higher priority when reversed later)
  const localNested = findRuleFile(
    path.join(projectDir, appDir),
    LOCAL_ENTRY_FILENAMES,
  )
  if (localNested) {
    const content = readRuleFile(localNested, context)
    if (content !== null) {
      out.push({
        dir: projectDir,
        label: `${appDir}/${path.basename(localNested)}`,
        content,
      })
    }
  }

  return out
}

function formatRuleSources(sources: RuleSource[], scopeLabel: string): string {
  if (sources.length === 0) return ''
  return sources
    .map(s =>
      sources.length === 1
        ? s.content
        : `<!-- from ${scopeLabel}:${s.label} -->\n${s.content}`,
    )
    .join('\n\n')
}

/**
 * Managed / policy rules.
 * Root entry: `{managed}/AGENTS.md`, else `{managed}/CLAUDE.md`.
 */
export function loadManagedRules(): string {
  const sources: RuleSource[] = []
  const managedRoot = getManagedDir()
  const context = createRuleLoadContext(managedRoot)
  for (const entryPath of getManagedMemoryEntryPaths()) {
    if (fs.existsSync(entryPath) && fs.statSync(entryPath).isFile()) {
      const content = readRuleFile(entryPath, context)
      if (content !== null) {
        sources.push({
          dir: managedRoot,
          label: path.basename(entryPath),
          content,
        })
      }
      break
    }
  }
  const rulesDir = getExtensionDir('managed', 'rules')
  sources.push(...collectRulesDir(managedRoot, rulesDir, 'rules', context))
  return formatRuleSources(sources, 'managed')
}

/** User-scope rules: ~/.ai-agent/AGENTS.md + ~/.ai-agent/rules/*.md */
export function loadUserRules(): string {
  const userDir = getUserAppDir()
  const context = createRuleLoadContext(getAgentHome())
  const sources: RuleSource[] = []
  const entry = findRuleFile(userDir, ENTRY_FILENAMES)
  if (entry) {
    const content = readRuleFile(entry, context)
    if (content !== null) {
      sources.push({ dir: userDir, label: path.basename(entry), content })
    }
  }
  sources.push(
    ...collectRulesDir(userDir, path.join(userDir, 'rules'), 'rules', context),
  )
  return formatRuleSources(sources, 'user')
}

/**
 * Load project agent instructions for `cwd`.
 * Prefer colocating under `{appDir}/AGENTS.md`; root `AGENTS.md` also works
 * (agents.md standard / monorepo packages). Includes AGENTS.local.md.
 */
export function loadProjectRules(cwd: string): string {
  const absDir = path.resolve(cwd)
  if (!isTrustedProjectDir(absDir)) return ''
  // A non-git workspace has no trusted ancestor contract. Keep discovery and
  // includes inside the selected workspace instead of walking to filesystem /.
  const ceiling = projectCeiling(absDir)

  const context = createRuleLoadContext(ceiling)
  const sourceGroups: RuleSource[][] = []
  let cur = absDir

  while (true) {
    const sources: RuleSource[] = []
    const single = findRuleFile(cur, ENTRY_FILENAMES)
    if (single) {
      const content = readRuleFile(single, context)
      if (content !== null) {
        sources.push({ dir: cur, label: path.basename(single), content })
      }
    }
    sources.push(...collectAppDirRules(cur, context))

    const local = findRuleFile(cur, LOCAL_ENTRY_FILENAMES)
    if (local) {
      const content = readRuleFile(local, context)
      if (content !== null) {
        sources.push({ dir: cur, label: path.basename(local), content })
      }
    }
    sourceGroups.push(sources)

    if (cur === ceiling || cur === path.dirname(cur)) break
    cur = path.dirname(cur)
  }

  // Reverse directory priority only. Within one directory preserve:
  // root entry → app entry → topic rules → local overrides.
  const sources = sourceGroups.reverse().flat()
  if (sources.length === 0) return ''

  let combined = sources
    .map(s => {
      if (sources.length === 1) return s.content
      const relDir = path.relative(path.resolve(cwd), s.dir) || '.'
      const header = relDir === '.' ? s.label : `${relDir}/${s.label}`
      return `<!-- from ${header} -->\n${s.content}`
    })
    .join('\n\n')

  if (Buffer.byteLength(combined, 'utf-8') > MAX_RULES_BYTES) {
    combined =
      combined.slice(0, MAX_RULES_BYTES) +
      '\n\n[...truncated — combined rules exceeded cap]'
  }

  return combined
}

export interface ConditionalRuleMatch {
  path: string
  label: string
  content: string
  patterns: string[]
}

/**
 * Load `paths:` rules matching files successfully read/written in this
 * session. These are kept out of the static system prompt and surfaced as
 * post-tool attachments.
 */
export function loadConditionalRulesForPaths(
  cwd: string,
  targetPaths: readonly string[],
): ConditionalRuleMatch[] {
  const absDir = path.resolve(cwd)
  if (!isTrustedProjectDir(absDir)) return []
  const ceiling = projectCeiling(absDir)
  const canonicalCeiling =
    canonicalExistingPath(ceiling) ?? path.resolve(ceiling)
  const safeTargets = targetPaths.filter(targetPath => {
    const canonical =
      canonicalExistingPath(targetPath) ?? path.resolve(targetPath)
    return isInsideRoot(canonical, canonicalCeiling)
  })
  if (safeTargets.length === 0) return []

  const sources: RuleSource[] = []
  const managedRoot = getManagedDir()
  sources.push(
    ...collectRulesDir(
      managedRoot,
      getExtensionDir('managed', 'rules'),
      'rules',
      createRuleLoadContext(managedRoot),
      {
        conditional: true,
        targetPaths: safeTargets,
        matchBaseDir: absDir,
      },
    ),
  )

  const userDir = getUserAppDir()
  sources.push(
    ...collectRulesDir(
      userDir,
      path.join(userDir, 'rules'),
      'rules',
      createRuleLoadContext(getAgentHome()),
      {
        conditional: true,
        targetPaths: safeTargets,
        matchBaseDir: absDir,
      },
    ),
  )

  const projectContext = createRuleLoadContext(ceiling)
  const projectGroups: RuleSource[][] = []
  let cur = absDir
  while (true) {
    projectGroups.push(
      collectRulesDir(
        cur,
        path.join(cur, getAppDirName(), 'rules'),
        `${getAppDirName()}/rules`,
        projectContext,
        {
          conditional: true,
          targetPaths: safeTargets,
          matchBaseDir: cur,
        },
      ),
    )
    if (cur === ceiling || cur === path.dirname(cur)) break
    cur = path.dirname(cur)
  }
  sources.push(...projectGroups.reverse().flat())

  let usedBytes = 0
  const matches: ConditionalRuleMatch[] = []
  for (const source of sources) {
    if (!source.filePath || !source.patterns) continue
    const bytes = Buffer.byteLength(source.content, 'utf-8')
    if (usedBytes + bytes > MAX_RULES_BYTES) break
    usedBytes += bytes
    matches.push({
      path: source.filePath,
      label: source.label,
      content: source.content,
      patterns: source.patterns,
    })
  }
  return matches
}

function combineRuleParts(parts: string[]): string {
  const present = parts.filter(s => s.trim())
  if (present.length === 0) return ''
  let combined = present.join('\n\n')
  if (Buffer.byteLength(combined, 'utf-8') > MAX_RULES_BYTES) {
    combined =
      combined.slice(0, MAX_RULES_BYTES) +
      '\n\n[...truncated — combined rules exceeded cap]'
  }
  return combined
}

/** Managed + request-scoped user rules, without any project traversal. */
export function loadUserAgentRules(): string {
  return combineRuleParts([loadManagedRules(), loadUserRules()])
}

/** Managed → user → project/local (closer project overrides among itself). */
export function loadAllAgentRules(cwd: string): string {
  const parts = [loadManagedRules(), loadUserRules(), loadProjectRules(cwd)]
  return combineRuleParts(parts)
}

export function hasRulesFile(cwd: string): boolean {
  const abs = path.resolve(cwd)
  if (!isTrustedProjectDir(abs)) return false
  if (findRuleFile(abs, ENTRY_FILENAMES) !== null) return true
  const ceiling = projectCeiling(abs)
  return collectAppDirRules(abs, createRuleLoadContext(ceiling)).length > 0
}
