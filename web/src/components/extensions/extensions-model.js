import { Document, parseDocument } from 'yaml'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export function joinConfigPath(...parts) {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

export function basename(path = '') {
  const normalized = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() || ''
}

export function extensionlessName(path = '') {
  return basename(path).replace(/\.[^.]+$/, '')
}

export function slugifyResourceName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeEntry(entry, parentPath = '') {
  if (typeof entry === 'string') {
    return {
      path: joinConfigPath(parentPath, entry),
      name: basename(entry),
      type: 'file',
      isDir: false,
    }
  }

  const name = entry.name || basename(entry.path)
  const path = joinConfigPath(
    entry.path || entry.relativePath || joinConfigPath(parentPath, name),
  )
  const type =
    entry.type === 'directory' ||
    entry.type === 'dir' ||
    entry.isDir === true ||
    Array.isArray(entry.children)
      ? 'directory'
      : 'file'

  return {
    ...entry,
    path,
    name: name || basename(path),
    type,
    isDir: type === 'directory',
    readOnly: Boolean(
      entry.readOnly ||
      entry.readonly ||
      entry.managed ||
      entry.source === 'marketplace' ||
      entry.ownership?.source === 'marketplace',
    ),
    source:
      entry.source ||
      entry.ownership?.source ||
      (entry.managed || entry.marketplace ? 'marketplace' : 'user'),
  }
}

/**
 * Accept the flat and nested response shapes used by user-config backends and
 * turn them into one stable, sorted list for the UI.
 */
export function normalizeConfigTree(response, root = '') {
  const raw =
    response?.entries ??
    response?.items ??
    response?.children ??
    response?.tree ??
    []
  const roots = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.children)
      ? raw.children
      : []
  const result = []

  const visit = (entry, parentPath) => {
    const normalized = normalizeEntry(entry, parentPath)
    if (normalized.path && normalized.path !== root) result.push(normalized)
    for (const child of entry?.children || []) {
      visit(child, normalized.path)
    }
  }

  for (const entry of roots) visit(entry, root)

  return result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

export function topLevelResources(entries, root, { folders = false } = {}) {
  const prefix = root ? `${root}/` : ''
  return entries.filter(entry => {
    if (!entry.path.startsWith(prefix)) return false
    const rest = entry.path.slice(prefix.length)
    if (!rest || rest.includes('/')) return false
    return folders ? entry.isDir : !entry.isDir
  })
}

function parseFrontmatter(source) {
  const document = parseDocument(source, {
    prettyErrors: false,
    keepSourceTokens: true,
  })
  if (document.errors.length > 0) throw document.errors[0]
  const value = document.toJS({ maxAliasCount: 100 })
  return {
    document,
    value:
      value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  }
}

export function parseMarkdownDocument(source = '') {
  const match = String(source).match(FRONTMATTER_RE)
  if (!match) {
    return { frontmatter: {}, body: String(source), hasFrontmatter: false }
  }

  try {
    const { value } = parseFrontmatter(match[1])
    return {
      frontmatter: value,
      body: String(source).slice(match[0].length),
      hasFrontmatter: true,
      parseError: null,
    }
  } catch (error) {
    return {
      frontmatter: {},
      body: String(source).slice(match[0].length),
      hasFrontmatter: true,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }
}

export function serializeMarkdownDocument(frontmatter, body = '') {
  const value = Object.fromEntries(
    Object.entries(frontmatter || {}).filter(
      ([, entry]) => entry !== undefined && entry !== null && entry !== '',
    ),
  )
  if (Object.keys(value).length === 0) return body
  const document = new Document(value)
  return `---\n${document.toString({ lineWidth: 0 })}---\n${body}`
}

/**
 * Update one top-level frontmatter field while preserving unrelated YAML,
 * including nested blocks the lightweight parser does not understand.
 */
export function updateMarkdownFrontmatterField(source, key, value) {
  const text = String(source || '')
  const match = text.match(FRONTMATTER_RE)
  if (!match) {
    return serializeMarkdownDocument(
      value === undefined || value === null || value === ''
        ? {}
        : { [key]: value },
      text,
    )
  }

  const { document } = parseFrontmatter(match[1])
  if (value === undefined || value === null || value === '') {
    document.delete(key)
  } else {
    document.set(key, value)
  }
  const body = text.slice(match[0].length)
  const yaml = document.toString({ lineWidth: 0 })
  return document.contents ? `---\n${yaml}---\n${body}` : body
}

export function updateMarkdownBody(source, body) {
  const text = String(source || '')
  const match = text.match(FRONTMATTER_RE)
  return match ? `${match[0]}${body}` : body
}

export function isTextResourceFile(path = '') {
  return /\.(?:md|mdx|txt|json|ya?ml|toml|js|jsx|ts|tsx|py|rb|go|rs|sh|bash|zsh|css|scss|html?|xml|csv|env)$/i.test(
    path,
  )
}

export function sourceLabel(source) {
  if (!source) return 'User'
  if (source === 'marketplace') return 'Marketplace'
  if (source === 'managed') return 'Managed'
  if (source === 'project') return 'Project'
  if (source === 'plugin') return 'Plugin'
  if (source === 'built-in') return 'Built-in'
  return source.charAt(0).toUpperCase() + source.slice(1)
}
