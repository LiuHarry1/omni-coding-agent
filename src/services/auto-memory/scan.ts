/**
 * Scan topic files + MEMORY.md index helpers.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import matter from 'gray-matter'
import { claimAiAgentPath } from '../../utils/sandbox-owner.js'
import {
  AUTO_MEM_ENTRYPOINT,
  getAutoMemEntrypoint,
  isAutoMemPath,
} from './paths.js'
import { parseMemoryType, type MemoryType } from './types.js'

/** Maximum number of index lines read from the memdir entrypoint. */
export const MAX_ENTRYPOINT_LINES = 200
/** Maximum number of bytes read from the memdir entrypoint. */
export const MAX_ENTRYPOINT_BYTES = 25_000
const MAX_INDEX_LINES = MAX_ENTRYPOINT_LINES
const MAX_INDEX_BYTES = MAX_ENTRYPOINT_BYTES
const MAX_SCAN_FILES = 200

/** Topic file header (plus legacy absPath/relPath aliases). */
export type MemoryFileMeta = {
  /** Relative path under memdir. */
  filename: string
  /** Absolute path. */
  filePath: string
  /** @deprecated use filePath */
  absPath: string
  /** @deprecated use filename */
  relPath: string
  name?: string
  description: string | null
  type?: MemoryType
  mtimeMs: number
}

type ParsedMemoryFrontmatter = {
  name?: string
  description?: string
  type?: string
}

const YAML_SPECIAL_VALUE_CHARS = /[{}[\]*&#!|>%@`]|: /

function quoteProblematicMemoryValues(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end < 0) return content
  const header = content
    .slice(0, end)
    .split('\n')
    .map(line => {
      const match = line.match(/^(name|description|type):\s+(.+)$/i)
      if (!match) return line
      const key = match[1]!
      const value = match[2]!.trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")) ||
        /^(?:[>|][-+]?)$/.test(value) ||
        !YAML_SPECIAL_VALUE_CHARS.test(value)
      ) {
        return line
      }
      return `${key}: ${JSON.stringify(value)}`
    })
    .join('\n')
  return header + content.slice(end)
}

function parseFrontmatter(content: string): ParsedMemoryFrontmatter {
  let data: Record<string, unknown>
  try {
    data = matter(content).data as Record<string, unknown>
  } catch {
    try {
      data = matter(quoteProblematicMemoryValues(content)).data as Record<
        string,
        unknown
      >
    } catch {
      return {}
    }
  }
  return {
    name: typeof data.name === 'string' ? data.name.trim() : undefined,
    description:
      typeof data.description === 'string'
        ? data.description.trim()
        : undefined,
    type: typeof data.type === 'string' ? data.type.trim() : undefined,
  }
}

function hasValidMemoryFrontmatter(content: string): boolean {
  const parsed = parseFrontmatter(content)
  return (
    !!parsed.name &&
    !!parsed.description &&
    parseMemoryType(parsed.type) !== undefined
  )
}

function normalizeIndentedMemoryKeys(content: string): string | undefined {
  if (!content.startsWith('---')) return undefined
  const end = content.indexOf('\n---', 3)
  if (end < 0) return undefined
  const header = content
    .slice(0, end)
    .split('\n')
    .map(line => line.replace(/^[ \t]+(name|description|type):[ \t]*/i, '$1: '))
    .join('\n')
  const next = quoteProblematicMemoryValues(header + content.slice(end))
  return next === content ? undefined : next
}

/** List topic .md files under memdir (excludes MEMORY.md), newest first. */
export function scanMemoryFiles(memPath: string): MemoryFileMeta[] {
  if (!fs.existsSync(memPath)) return []
  const out: MemoryFileMeta[] = []

  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // Skip team/logs plus local hold/backup dirs (e.g. _backup_*).
        if (
          ent.name === 'team' ||
          ent.name === 'logs' ||
          ent.name.startsWith('_')
        ) {
          continue
        }
        walk(abs)
        continue
      }
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue
      if (ent.name === AUTO_MEM_ENTRYPOINT) continue
      let content: string
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
        content = fs.readFileSync(abs, 'utf-8')
      } catch {
        continue
      }
      const fm = parseFrontmatter(content)
      const rel = path.relative(memPath, abs).split(path.sep).join('/')
      out.push({
        filename: rel,
        filePath: abs,
        absPath: abs,
        relPath: rel,
        name: fm.name,
        description: fm.description ?? null,
        type: parseMemoryType(fm.type),
        mtimeMs: st.mtimeMs,
      })
    }
  }

  walk(memPath)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, MAX_SCAN_FILES)
}

export type MemoryFrontmatterRepairResult = {
  repaired: number
  invalid: number
}

/**
 * Validate only files actually written during the current memory operation.
 * Safely dedent known schema keys, then atomically replace the file only when
 * the repaired header parses as a complete valid memory frontmatter.
 */
export function repairMemoryFrontmatterFiles(
  memPath: string,
  writtenPaths: readonly string[],
): MemoryFrontmatterRepairResult {
  let repaired = 0
  let invalid = 0
  const uniquePaths = new Set(
    writtenPaths.map(filePath => path.resolve(filePath)),
  )
  for (const filePath of uniquePaths) {
    if (
      path.basename(filePath) === AUTO_MEM_ENTRYPOINT ||
      !isAutoMemPath(filePath, memPath)
    ) {
      continue
    }
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }
    if (hasValidMemoryFrontmatter(raw)) continue

    const next = normalizeIndentedMemoryKeys(raw)
    if (!next || !hasValidMemoryFrontmatter(next)) {
      invalid++
      console.warn(`[auto-memory] invalid frontmatter file=${filePath}`)
      continue
    }

    const tmp = `${filePath}.${process.pid}.${randomUUID()}.frontmatter.tmp`
    try {
      fs.writeFileSync(tmp, next, { encoding: 'utf-8', mode: 0o600 })
      // Do not overwrite a concurrent edit made after our validation read.
      if (fs.readFileSync(filePath, 'utf-8') !== raw) {
        invalid++
        continue
      }
      fs.renameSync(tmp, filePath)
      claimAiAgentPath(filePath)
      repaired++
      console.warn(`[auto-memory] repaired frontmatter file=${filePath}`)
    } finally {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  return { repaired, invalid }
}

/**
 * Format: `- [type] filename (ISO): description`
 */
export function formatMemoryManifest(files: MemoryFileMeta[]): string {
  if (files.length === 0) return ''
  return files
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}

/** Truncate MEMORY.md to line + byte caps (tools/UI and legacy index inject). */
export function truncateEntrypointContent(raw: string): {
  content: string
  truncated: boolean
} {
  const lines = raw.split('\n')
  let truncated = false
  let kept = lines
  if (kept.length > MAX_INDEX_LINES) {
    kept = kept.slice(0, MAX_INDEX_LINES)
    truncated = true
  }
  let content = kept.join('\n')
  if (Buffer.byteLength(content, 'utf-8') > MAX_INDEX_BYTES) {
    truncated = true
    while (
      content.length > 0 &&
      Buffer.byteLength(content, 'utf-8') > MAX_INDEX_BYTES
    ) {
      const nl = content.lastIndexOf('\n')
      content = nl >= 0 ? content.slice(0, nl) : ''
    }
  }
  if (truncated) {
    content =
      content.replace(/\n*$/, '') +
      '\n\n[... truncated — keep MEMORY.md concise; older lines omitted]'
  }
  return { content, truncated }
}

export function readEntrypointRaw(memPath: string): string {
  const p = getAutoMemEntrypoint(memPath)
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Ensure index mentions relPath; append a stub line if missing.
 * Returns true if the index was modified.
 */
export function ensureIndexEntry(
  memPath: string,
  relPath: string,
  title: string,
  hook?: string | null,
): boolean {
  const entry = getAutoMemEntrypoint(memPath)
  let raw = ''
  try {
    raw = fs.readFileSync(entry, 'utf-8')
  } catch {
    raw = ''
  }
  if (raw.includes(`](${relPath})`) || raw.includes(`](./${relPath})`)) {
    return false
  }
  const line = `- [${title}](${relPath})${hook ? ` — ${hook}` : ''}`
  const next = raw.trimEnd()
    ? `${raw.replace(/\n*$/, '')}\n${line}\n`
    : `${line}\n`
  fs.writeFileSync(entry, next, { encoding: 'utf-8', mode: 0o600 })
  claimAiAgentPath(entry)
  return true
}

/** Rebuild MEMORY.md from scanned topic files. */
export function rebuildIndex(memPath: string): void {
  const files = scanMemoryFiles(memPath)
  const lines = files.map(f => {
    const title = f.name ?? f.filename.replace(/\.md$/i, '')
    const hook = f.description ?? ''
    return `- [${title}](${f.filename})${hook ? ` — ${hook}` : ''}`
  })
  const body = lines.length ? lines.join('\n') + '\n' : ''
  const entry = getAutoMemEntrypoint(memPath)
  fs.writeFileSync(entry, body, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  claimAiAgentPath(entry)
}

/** Read a file capped by line and/or byte limits (for surfacing memories). */
export function readFileCapped(
  absPath: string,
  maxLines: number,
  maxBytes: number,
): {
  content: string
  totalLines: number
  truncatedByLines: boolean
  truncatedByBytes: boolean
  lineCount: number
  mtimeMs: number
} {
  const st = fs.statSync(absPath)
  const raw = fs.readFileSync(absPath, 'utf-8')
  const allLines = raw.split('\n')
  const totalLines = allLines.length
  let truncatedByLines = false
  let truncatedByBytes = false
  let lines = allLines
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines)
    truncatedByLines = true
  }
  let content = lines.join('\n')
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    truncatedByBytes = true
    while (
      content.length > 0 &&
      Buffer.byteLength(content, 'utf-8') > maxBytes
    ) {
      const nl = content.lastIndexOf('\n')
      content = nl >= 0 ? content.slice(0, nl) : content.slice(0, maxBytes)
    }
  }
  return {
    content,
    totalLines,
    truncatedByLines,
    truncatedByBytes,
    lineCount: content.split('\n').length,
    mtimeMs: st.mtimeMs,
  }
}
