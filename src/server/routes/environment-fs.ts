import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { readBody, sendJSON } from '../http.js'
import type { ExecutionPlane } from '../../execution/index.js'
import {
  remotePathShell,
  ShellFsError,
  ShellFsPort,
  shQuote,
} from '../../execution/shell-fs.js'
import { WALK_IGNORE_DIR_NAMES } from '../../constants/file_filters.js'
import { gitDiffWith, gitStatusWith, shellGitHost } from '../workspace/git.js'
import {
  contentDisposition,
  mimeTypeFor,
  receiveUpload,
} from '../workspace/transfer.js'
import { containsGitMetadataPath } from '../workspace/path-safety.js'
import { normalizeGitRelativePath } from '../workspace/git.js'

/** Same caps as the local `/workspace` module (fs-ops.ts). */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 5 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 10 * 60_000
const MAX_SEARCH_ENTRIES = 10_000

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  ENOENT: 404,
  EEXIST: 409,
  EISDIR: 409,
  ENOTDIR: 409,
  EACCES: 403,
  EINVAL: 400,
  EMTIME: 409,
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (err instanceof HttpError) {
    sendJSON(res, err.status, { error: err.message, code: err.code })
  } else if (err instanceof ShellFsError) {
    sendJSON(res, STATUS_BY_CODE[err.code] ?? 500, {
      error: err.message,
      code: err.code,
    })
  } else {
    sendJSON(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || !value.trim()) {
    throw new HttpError(400, 'EINVAL', `Missing '${name}'`)
  }
  return value
}

function writablePath(value: unknown, name = 'path'): string {
  const target = required(value, name)
  if (containsGitMetadataPath(target)) {
    throw new HttpError(
      403,
      'EACCES',
      'Git metadata must be changed through Git, not the file API',
    )
  }
  return target
}

function normalizedRemotePath(value: string): string {
  const normalized = path.posix.normalize(value)
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

export async function assertSafeEnvironmentDelete(
  port: ShellFsPort,
  targetPath: string,
  workspaceRoot: string,
): Promise<void> {
  if (!targetPath.trim()) {
    throw new HttpError(400, 'EINVAL', 'Refusing to delete a blank path')
  }
  const [target, root, home] = await Promise.all([
    port.realpath(targetPath),
    port.realpath(workspaceRoot),
    port.realpath('~'),
  ])
  const protectedPaths = new Set([
    '/',
    normalizedRemotePath(root),
    normalizedRemotePath(home),
  ])
  if (protectedPaths.has(normalizedRemotePath(target))) {
    throw new HttpError(
      400,
      'EINVAL',
      'Refusing to delete a filesystem, HOME, or workspace root',
    )
  }
}

export type ReadFileResult = {
  path: string
  content: string
  size: number
  truncated: boolean
  isBinary: boolean
  mtimeMs: number
}

async function readFileResult(
  port: ShellFsPort,
  filePath: string,
): Promise<ReadFileResult> {
  const st = await port.stat(filePath)
  if (st.type !== 'file') {
    throw new HttpError(404, 'ENOENT', `File not found: ${filePath}`)
  }
  const size = st.size ?? 0
  const mtimeMs = st.mtimeMs ?? 0
  const truncated = size > MAX_PREVIEW_BYTES
  const buf = await port.readHead(filePath, Math.min(size, MAX_PREVIEW_BYTES))
  // Heuristic shared with the local viewer: a NUL in the first 8 KB.
  if (buf.subarray(0, 8192).includes(0)) {
    return {
      path: filePath,
      content: '',
      size,
      truncated: false,
      isBinary: true,
      mtimeMs,
    }
  }
  return {
    path: filePath,
    content: buf.toString('utf8'),
    size,
    truncated,
    isBinary: false,
    mtimeMs,
  }
}

function textPayload(content: unknown): Buffer {
  const buf = Buffer.from(typeof content === 'string' ? content : '', 'utf8')
  if (buf.length > MAX_WRITE_BYTES) {
    throw new HttpError(
      413,
      'E2BIG',
      `Content exceeds ${MAX_WRITE_BYTES} bytes`,
    )
  }
  return buf
}

/** `report.pdf` next to an existing `report.pdf` → `report (1).pdf`. */
function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name
  const ext = path.posix.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

type EnvironmentSearchEntry = { path: string; isDir: boolean }

function visibleSearchPath(relative: string, showHidden: boolean): boolean {
  return relative.split('/').every(segment => {
    if (!segment.startsWith('.')) return true
    return (
      showHidden ||
      segment === '.ai-agent' ||
      segment === '.env' ||
      segment.startsWith('.env.')
    )
  })
}

function scoreSearchPath(relative: string, query: string): number {
  const lower = relative.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  if (base.startsWith(query)) return 200 - lower.length
  if (lower.startsWith(query)) return 150 - lower.length
  if (lower.includes(query)) return 80 - lower.length
  let queryIndex = 0
  for (
    let index = 0;
    index < base.length && queryIndex < query.length;
    index++
  ) {
    if (base[index] === query[queryIndex]) queryIndex++
  }
  return queryIndex === query.length ? 40 - lower.length : 0
}

export async function searchEnvironmentFiles(
  port: ShellFsPort,
  rootPath: string,
  query: string,
  limit: number,
  showHidden: boolean,
): Promise<{ query: string; entries: EnvironmentSearchEntry[] }> {
  const root = await port.realpath(rootPath)
  const ignored = [...WALK_IGNORE_DIR_NAMES]
    .map(name => `-name ${shQuote(name)}`)
    .join(' -o ')
  const result = await port.run(
    `
set -e
d=${remotePathShell(root)}
count=0
find "$d" -mindepth 1 -maxdepth 16 \\( -type d \\( ${ignored} \\) -prune -o -print \\) 2>/dev/null |
while IFS= read -r item; do
  if [ -d "$item" ]; then kind=d
  elif [ -f "$item" ]; then kind=f
  else continue
  fi
  printf '%s\\t%s\\n' "$kind" "$item"
  count=$((count + 1))
  [ "$count" -lt ${MAX_SEARCH_ENTRIES} ] || break
done
`,
    { timeoutMs: 20_000 },
  )
  if (result.code !== 0) {
    throw new ShellFsError(
      'EIO',
      result.stderr.trim() || `Could not search workspace: ${root}`,
    )
  }

  const prefix = root === '/' ? '/' : `${root}/`
  const entries: EnvironmentSearchEntry[] = []
  for (const line of result.stdout.toString('utf8').split(/\r?\n/)) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const kind = line.slice(0, tab)
    const absolute = line.slice(tab + 1)
    if (!absolute.startsWith(prefix)) continue
    const relative = absolute.slice(prefix.length)
    if (
      !relative ||
      !visibleSearchPath(relative, showHidden) ||
      relative.split('/').some(segment => WALK_IGNORE_DIR_NAMES.has(segment))
    ) {
      continue
    }
    entries.push({ path: relative, isDir: kind === 'd' })
  }

  const normalizedQuery = query.trim().toLowerCase()
  const matches = normalizedQuery
    ? entries
        .map(entry => ({
          entry,
          score: scoreSearchPath(entry.path, normalizedQuery),
        }))
        .filter(match => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.entry.path.localeCompare(right.entry.path),
        )
        .slice(0, limit)
        .map(match => match.entry)
    : entries
        .sort((left, right) => {
          if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
          return left.path.localeCompare(right.path)
        })
        .slice(0, limit)
  return { query, entries: matches }
}

export type EnvironmentFsDeps = {
  plane: ExecutionPlane
  canUse: (req: IncomingMessage, environmentId: string) => boolean
}

/**
 * Editing API for files inside a shell-reachable environment (cloud
 * container, SSH host). Mirrors `/workspace/*` payloads so the IDE handles
 * both the same way; local folders keep using `/workspace/*`.
 *
 * GET    /environments/fs/file?environmentId=&path=
 * GET    /environments/fs/search?environmentId=&dir=&q=&limit=
 * POST   /environments/fs/file      { environmentId, path, content }
 * PUT    /environments/fs/file      { environmentId, path, content, mtimeMs? }
 * POST   /environments/fs/mkdir     { environmentId, path }
 * DELETE /environments/fs/entry?environmentId=&path=
 * POST   /environments/fs/upload    multipart: environmentId, dir, file[]
 * GET    /environments/fs/download?environmentId=&path=   (dir → .tar.gz)
 * GET    /environments/git/status?environmentId=&root=
 * GET    /environments/git/diff?environmentId=&root=&path=
 */
export async function handleEnvironmentFs(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EnvironmentFsDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  const url = req.url ?? ''
  const pathOnly = url.split('?')[0]
  const route = `${method} ${pathOnly}`
  const routes = new Set([
    'GET /environments/fs/file',
    'GET /environments/fs/search',
    'POST /environments/fs/file',
    'PUT /environments/fs/file',
    'POST /environments/fs/mkdir',
    'DELETE /environments/fs/entry',
    'POST /environments/fs/upload',
    'GET /environments/fs/download',
    'GET /environments/git/status',
    'GET /environments/git/diff',
  ])
  if (!routes.has(route)) return false

  const query = new URL(url, 'http://localhost').searchParams
  const targetFor = async (
    environmentId: string,
  ): Promise<{ port: ShellFsPort; workspaceRoot: string }> => {
    const env = deps.canUse(req, environmentId)
      ? await deps.plane.registry.resolve(environmentId).catch(() => null)
      : null
    if (!env) throw new HttpError(404, 'ENOENT', 'Environment not found')
    const port =
      env.kind === 'local'
        ? null
        : await deps.plane.workspaces.ensureFs(environmentId)
    if (!(port instanceof ShellFsPort)) {
      throw new HttpError(
        400,
        'EINVAL',
        'Use /workspace/* for files on this machine',
      )
    }
    return { port, workspaceRoot: env.defaultCwd || '~' }
  }
  const portFor = async (environmentId: string): Promise<ShellFsPort> =>
    (await targetFor(environmentId)).port

  try {
    if (route === 'POST /environments/fs/upload') {
      await handleUpload(req, res, portFor)
      return true
    }

    if (method === 'GET') {
      const port = await portFor(
        required(query.get('environmentId'), 'environmentId'),
      )
      if (route === 'GET /environments/fs/file') {
        const p = required(query.get('path'), 'path')
        sendJSON(res, 200, await readFileResult(port, p))
      } else if (route === 'GET /environments/fs/search') {
        const limit = Math.min(
          50,
          Math.max(1, Number.parseInt(query.get('limit') ?? '15', 10) || 15),
        )
        sendJSON(
          res,
          200,
          await searchEnvironmentFiles(
            port,
            required(query.get('dir'), 'dir'),
            query.get('q') ?? '',
            limit,
            query.get('showHidden') === '1' ||
              query.get('showHidden') === 'true',
          ),
        )
      } else if (route === 'GET /environments/fs/download') {
        await sendDownload(res, port, required(query.get('path'), 'path'))
      } else {
        const root = required(query.get('root'), 'root')
        const host = shellGitHost(port, root)
        if (route === 'GET /environments/git/status') {
          sendJSON(res, 200, await gitStatusWith(host))
        } else {
          let p: string
          try {
            p = normalizeGitRelativePath(required(query.get('path'), 'path'))
          } catch (error) {
            throw new HttpError(
              403,
              'EACCES',
              error instanceof Error ? error.message : 'Invalid Git path',
            )
          }
          sendJSON(res, 200, await gitDiffWith(host, p))
        }
      }
      return true
    }

    if (route === 'DELETE /environments/fs/entry') {
      const target = await targetFor(
        required(query.get('environmentId'), 'environmentId'),
      )
      const p = writablePath(query.get('path'))
      await assertSafeEnvironmentDelete(target.port, p, target.workspaceRoot)
      await target.port.remove(p)
      sendJSON(res, 200, { path: p })
      return true
    }

    const body = await readBody(req)
    const port = await portFor(required(body.environmentId, 'environmentId'))
    const p = writablePath(body.path)

    if (route === 'POST /environments/fs/mkdir') {
      await port.mkdir(p)
      sendJSON(res, 200, { path: p })
      return true
    }

    if (route === 'POST /environments/fs/file') {
      await port.writeFile(p, textPayload(body.content), { exclusive: true })
      sendJSON(res, 200, await readFileResult(port, p))
      return true
    }

    // PUT /environments/fs/file
    if (typeof body.content !== 'string') {
      throw new HttpError(400, 'EINVAL', "Missing 'content'")
    }
    const content = textPayload(body.content)
    const expected = body.mtimeMs
    if (
      expected !== undefined &&
      (typeof expected !== 'number' || !Number.isFinite(expected))
    ) {
      throw new HttpError(400, 'EINVAL', 'mtimeMs must be a finite number')
    }
    await port.writeFileAtomic(p, content, {
      requireExisting: true,
      expectedMtimeMs: expected as number | undefined,
    })
    sendJSON(res, 200, await readFileResult(port, p))
    return true
  } catch (err) {
    sendError(res, err)
    return true
  }
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  portFor: (environmentId: string) => Promise<ShellFsPort>,
): Promise<void> {
  const { fields, files, cleanup } = await receiveUpload(req, res)
  try {
    const port = await portFor(required(fields.environmentId, 'environmentId'))
    const dir = writablePath(fields.dir, 'dir')
    if (files.length === 0) {
      throw new HttpError(400, 'EINVAL', 'No files in upload')
    }
    const st = await port.stat(dir).catch(() => null)
    if (st?.type !== 'dir') {
      throw new HttpError(404, 'ENOENT', `Target directory not found: ${dir}`)
    }
    const targetDir = st.path
    const taken = new Set((await port.list(targetDir)).map(e => e.name))
    const uploaded: Array<{ name: string; path: string; size: number }> = []
    for (const f of files) {
      if (!f.name) continue
      const name = uniqueName(taken, f.name)
      taken.add(name)
      const dest = path.posix.join(targetDir, name)
      await port.writeFile(dest, fs.createReadStream(f.path), {
        exclusive: true,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      })
      uploaded.push({ name, path: dest, size: f.size })
    }
    sendJSON(res, 200, { dir: targetDir, uploaded })
  } finally {
    await cleanup()
  }
}

async function sendDownload(
  res: ServerResponse,
  port: ShellFsPort,
  target: string,
): Promise<void> {
  const st = await port.stat(target)
  const isDir = st.type === 'dir'
  if (!isDir && st.type !== 'file') {
    throw new HttpError(404, 'ENOENT', `Not found: ${target}`)
  }
  const base = path.posix.basename(st.path) || 'workspace'
  const child = await port.spawn(
    isDir ? `tar -czf - -C ${shQuote(st.path)} .` : `cat ${shQuote(st.path)}`,
  )
  child.stdin?.end()
  const name = isDir ? `${base}.tar.gz` : base
  res.writeHead(200, {
    'Content-Type': isDir ? 'application/gzip' : mimeTypeFor(name),
    ...(isDir ? {} : { 'Content-Length': String(st.size) }),
    'Content-Disposition': contentDisposition(name),
  })
  await new Promise<void>(resolve => {
    child.stdout?.pipe(res)
    child.on('error', () => {
      res.destroy()
      resolve()
    })
    child.on('close', code => {
      // A failed archive mid-stream must not look like a complete download.
      if (code !== 0) res.destroy()
      resolve()
    })
    res.on('close', () => {
      if (child.exitCode === null) child.kill()
    })
  })
}
