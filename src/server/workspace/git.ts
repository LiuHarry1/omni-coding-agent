import { execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { shQuote, type ShellFsPort } from '../../execution/shell-fs.js'

/**
 * Read-only git helpers for the workspace IDE's "Changes" view.
 *
 * - Status: parse `git status --porcelain=v1 -z --untracked-files=all`
 *   plus `git diff --numstat -z HEAD` for line counts.
 * - Diff:   compare HEAD vs working tree for tracked files; treat
 *   untracked as "all added" and deleted as "all removed".
 *
 * Path-safety: every caller-supplied path is joined against the workspace
 * root and the result must remain inside it. The wider workspace module
 * intentionally doesn't sandbox `resolvePath`, but git operations are
 * tied to a specific repo and we don't want a stray `..` to leak diffs
 * from outside the tree.
 *
 * Git and file reads go through a `GitHost`, so the same parsing serves a
 * repo on this machine and one inside a remote environment.
 */

const MAX_DIFF_BYTES = 1.5 * 1024 * 1024
const SAFE_GIT_CONFIG_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
] as const

function hardenedGitArgs(args: string[]): string[] {
  return [...SAFE_GIT_CONFIG_ARGS, ...args]
}

function hardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  }
  delete env.GIT_EXTERNAL_DIFF
  delete env.GIT_DIFF_OPTS
  return env
}

/** Normalize a client path to a portable repo-relative Git path. */
export function normalizeGitRelativePath(input: string): string {
  if (!input || input.includes('\0')) throw new Error('Invalid Git path')
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new Error('Git path must be relative to the repository')
  }
  const segments = input.replace(/\\/g, '/').split('/')
  if (
    segments.length === 0 ||
    segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Git path must stay inside the repository')
  }
  return segments.join('/')
}

export interface GitHost {
  /** `git <args>` in the repo root. Resolves with the exit code. */
  git(args: string[]): Promise<{ stdout: string; code: number }>
  /** Absolute path of a repo-relative path. */
  resolve(relPath: string): string
  /** UTF-8 contents; '' when missing or larger than `maxBytes`. */
  readText(absPath: string, maxBytes: number): Promise<string>
  size(absPath: string): Promise<number | null>
  /** Line count and NUL sniff (first 8KB) for untracked files. */
  describe(
    absPaths: string[],
  ): Promise<Map<string, { lines: number; isBinary: boolean }>>
}

export type ChangeStatus =
  'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'

export interface ChangeEntry {
  path: string
  absPath: string
  status: ChangeStatus
  oldPath?: string
  insertions: number
  deletions: number
  isBinary: boolean
}

export interface ChangesSummary {
  isGitRepo: boolean
  branch: string | null
  entries: ChangeEntry[]
  totals: { files: number; insertions: number; deletions: number }
}

export interface FileDiff {
  path: string
  status: ChangeStatus
  isBinary: boolean
  oldContent: string
  newContent: string
  truncated: boolean
}

function gitExec(
  root: string,
  args: string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise(resolve => {
    execFile(
      'git',
      hardenedGitArgs(args),
      {
        cwd: root,
        env: hardenedGitEnv(),
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        // Binary-safe: keep bytes intact for the porcelain `-z` parser.
        encoding: 'buffer',
      } as any,
      (err, stdoutBuf) => {
        const stdout = Buffer.isBuffer(stdoutBuf)
          ? stdoutBuf.toString('utf8')
          : String(stdoutBuf || '')
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code
          resolve({ stdout, code: typeof code === 'number' ? code : 1 })
          return
        }
        resolve({ stdout, code: 0 })
      },
    )
  })
}

/** Best-effort line count for untracked files. */
function countLines(absPath: string): number {
  try {
    const buf = fs.readFileSync(absPath)
    if (buf.length === 0) return 0
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
    if (buf[buf.length - 1] !== 0x0a) n++
    return n
  } catch {
    return 0
  }
}

/**
 * Cheap binary heuristic for untracked files: a NUL byte in the first
 * 8KB. Matches what most diff tools (and git itself) do for new files.
 */
function looksBinary(absPath: string): boolean {
  try {
    const fd = fs.openSync(absPath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      for (let i = 0; i < n; i++) if (buf[i] === 0) return true
      return false
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Repo on this machine. */
export function localGitHost(root: string): GitHost {
  return {
    git: args =>
      fs.existsSync(root)
        ? gitExec(root, args)
        : Promise.resolve({ stdout: '', code: 128 }),
    resolve: rel => path.resolve(root, rel),
    readText: async (absPath, maxBytes) => {
      try {
        const stat = fs.lstatSync(absPath)
        if (!stat.isFile() || stat.isSymbolicLink()) return ''
        if (stat.size > maxBytes) return ''
        return fs.readFileSync(absPath, 'utf8')
      } catch {
        return ''
      }
    },
    size: async absPath => {
      try {
        const stat = fs.lstatSync(absPath)
        return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null
      } catch {
        return null
      }
    },
    describe: async absPaths => {
      const out = new Map<string, { lines: number; isBinary: boolean }>()
      for (const p of absPaths) {
        const isBinary = looksBinary(p)
        out.set(p, { lines: isBinary ? 0 : countLines(p), isBinary })
      }
      return out
    },
  }
}

/** Same sniffing as `countLines` / `looksBinary`, one script for all paths. */
const DESCRIBE_SCRIPT = `
while IFS= read -r p; do
  if [ -L "$p" ] || [ ! -f "$p" ]; then printf '0\\t0\\n'; continue; fi
  n=$(wc -l < "$p" | tr -d ' ')
  if [ -s "$p" ] && [ "$(tail -c 1 "$p" | wc -l | tr -d ' ')" = 0 ]; then n=$((n + 1)); fi
  a=$(head -c 8192 "$p" | wc -c | tr -d ' ')
  b=$(head -c 8192 "$p" | tr -d '\\000' | wc -c | tr -d ' ')
  if [ "$a" = "$b" ]; then printf '%s\\t0\\n' "$n"; else printf '0\\t1\\n'; fi
done
`

/** Repo inside a shell-reachable environment (container, SSH host). */
export function shellGitHost(fs: ShellFsPort, root: string): GitHost {
  const cd = `cd ${shQuote(root)} || exit 128`
  return {
    git: async args => {
      const gitArgs = hardenedGitArgs(args).map(shQuote).join(' ')
      const r = await fs.run(
        `${cd}; unset GIT_EXTERNAL_DIFF GIT_DIFF_OPTS; ` +
          `exec env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null ` +
          `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat ` +
          `git ${gitArgs}`,
        { timeoutMs: 60_000 },
      )
      return { stdout: r.stdout.toString('utf8'), code: r.code ?? 1 }
    },
    resolve: rel => path.posix.resolve(root, rel),
    readText: async (absPath, maxBytes) => {
      const p = shQuote(absPath)
      const r = await fs.run(
        `[ ! -L ${p} ] && [ -f ${p} ] || exit 0; ` +
          `[ "$(wc -c < ${p})" -gt ${maxBytes} ] && exit 0; cat ${p}`,
      )
      return r.code === 0 ? r.stdout.toString('utf8') : ''
    },
    size: async absPath => {
      const p = shQuote(absPath)
      const r = await fs.run(`[ ! -L ${p} ] && [ -f ${p} ] && wc -c < ${p}`)
      const n = Number.parseInt(r.stdout.toString('utf8').trim(), 10)
      return r.code === 0 && Number.isFinite(n) ? n : null
    },
    describe: async absPaths => {
      const out = new Map<string, { lines: number; isBinary: boolean }>()
      // The script reads one path per line; a name with a newline would
      // desync the rows, so it just gets no line count.
      const paths = absPaths.filter(p => !p.includes('\n'))
      if (paths.length === 0) return out
      const r = await fs.run(DESCRIBE_SCRIPT, {
        input: Buffer.from(paths.join('\n') + '\n', 'utf8'),
        timeoutMs: 120_000,
      })
      const rows = r.stdout.toString('utf8').split('\n')
      paths.forEach((p, i) => {
        const [lines, bin] = (rows[i] ?? '').split('\t')
        out.set(p, { lines: Number(lines) || 0, isBinary: bin === '1' })
      })
      return out
    },
  }
}

/** True iff the directory is inside a git working tree. */
async function isGitRepo(host: GitHost): Promise<boolean> {
  const r = await host.git(['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

async function currentBranch(host: GitHost): Promise<string | null> {
  const r = await host.git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (r.code !== 0) return null
  const name = r.stdout.trim()
  return name === 'HEAD' ? null : name
}

/**
 * Parse `git status --porcelain=v1 -z`. Records are NUL-separated;
 * renames occupy TWO records: `R<x> newPath\0oldPath\0`.
 *
 * We collapse XY → a single high-level status:
 *   `??`     → untracked
 *   `R*`/`*R`→ renamed
 *   `*D`/`D*`→ deleted
 *   `*A`/`A*`→ added
 *   anything else with a non-space → modified
 */
function parseStatusZ(buf: string): Array<{
  status: ChangeStatus
  path: string
  oldPath?: string
}> {
  const out: Array<{ status: ChangeStatus; path: string; oldPath?: string }> =
    []
  // Walk records: each starts with 2 status chars + space.
  let i = 0
  while (i < buf.length) {
    // A record looks like "XY path\0" (or "R<x> new\0old\0").
    const x = buf[i]
    const y = buf[i + 1]
    if (x === undefined || y === undefined) break
    // Skip the space at index i+2.
    let end = buf.indexOf('\0', i + 3)
    if (end === -1) break
    const filePath = buf.slice(i + 3, end)
    let oldPath: string | undefined
    let status: ChangeStatus

    const isRename = x === 'R' || y === 'R'
    if (isRename) {
      const oldEnd = buf.indexOf('\0', end + 1)
      if (oldEnd === -1) break
      oldPath = buf.slice(end + 1, oldEnd)
      end = oldEnd
      status = 'renamed'
    } else if (x === '?' && y === '?') {
      status = 'untracked'
    } else if (x === 'D' || y === 'D') {
      status = 'deleted'
    } else if (x === 'A' || y === 'A') {
      status = 'added'
    } else {
      status = 'modified'
    }

    out.push({ status, path: filePath, oldPath })
    i = end + 1
  }
  return out
}

/**
 * `git diff --numstat -z HEAD` for tracked changes. Output format
 * (NUL-separated): `<ins>\t<del>\t<path>\0` per record. Binary files
 * report `-\t-`. Renames produce `<ins>\t<del>\t<old>\0<new>\0` —
 * we key by the new path to align with status entries.
 */
async function trackedNumstats(
  host: GitHost,
): Promise<
  Map<string, { insertions: number; deletions: number; isBinary: boolean }>
> {
  const r = await host.git([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    '-z',
    'HEAD',
  ])
  const out = new Map<
    string,
    { insertions: number; deletions: number; isBinary: boolean }
  >()
  if (r.code !== 0) return out
  const buf = r.stdout
  let i = 0
  while (i < buf.length) {
    const tab1 = buf.indexOf('\t', i)
    if (tab1 === -1) break
    const tab2 = buf.indexOf('\t', tab1 + 1)
    if (tab2 === -1) break
    const insRaw = buf.slice(i, tab1)
    const delRaw = buf.slice(tab1 + 1, tab2)
    let end = buf.indexOf('\0', tab2 + 1)
    if (end === -1) break
    let p = buf.slice(tab2 + 1, end)
    // Rename: numstat path is empty → next NUL-separated pair is old\0new\0
    if (!p) {
      const e2 = buf.indexOf('\0', end + 1)
      if (e2 === -1) break
      end = e2
      const e3 = buf.indexOf('\0', end + 1)
      if (e3 === -1) break
      p = buf.slice(end + 1, e3)
      end = e3
    }
    const isBinary = insRaw === '-' && delRaw === '-'
    out.set(p, {
      insertions: isBinary ? 0 : parseInt(insRaw, 10) || 0,
      deletions: isBinary ? 0 : parseInt(delRaw, 10) || 0,
      isBinary,
    })
    i = end + 1
  }
  return out
}

export function gitStatus(root: string): Promise<ChangesSummary> {
  return gitStatusWith(localGitHost(root))
}

export async function gitStatusWith(host: GitHost): Promise<ChangesSummary> {
  if (!(await isGitRepo(host))) {
    return {
      isGitRepo: false,
      branch: null,
      entries: [],
      totals: { files: 0, insertions: 0, deletions: 0 },
    }
  }
  const [statusRes, numstats, branch] = await Promise.all([
    host.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    trackedNumstats(host),
    currentBranch(host),
  ])
  if (statusRes.code !== 0) {
    throw new Error(`git status exited ${statusRes.code}`)
  }
  const raw = parseStatusZ(statusRes.stdout)
  const untracked = await host.describe(
    raw.filter(r => r.status === 'untracked').map(r => host.resolve(r.path)),
  )

  const entries: ChangeEntry[] = raw.map(r => {
    const absPath = host.resolve(r.path)
    if (r.status === 'untracked') {
      const info = untracked.get(absPath)
      const isBinary = info?.isBinary ?? false
      return {
        path: r.path,
        absPath,
        status: r.status,
        insertions: isBinary ? 0 : (info?.lines ?? 0),
        deletions: 0,
        isBinary,
      }
    }
    const n = numstats.get(r.path)
    return {
      path: r.path,
      absPath,
      status: r.status,
      oldPath: r.oldPath,
      insertions: n?.insertions ?? 0,
      deletions: n?.deletions ?? 0,
      isBinary: n?.isBinary ?? false,
    }
  })

  // Stable sort: directory + path so siblings group naturally.
  entries.sort((a, b) => a.path.localeCompare(b.path))

  const totals = entries.reduce(
    (acc, e) => ({
      files: acc.files + 1,
      insertions: acc.insertions + e.insertions,
      deletions: acc.deletions + e.deletions,
    }),
    { files: 0, insertions: 0, deletions: 0 },
  )

  return { isGitRepo: true, branch, entries, totals }
}

/** Read HEAD:<path>; returns "" if the file didn't exist at HEAD. */
async function readHead(host: GitHost, p: string): Promise<string> {
  const r = await host.git(['show', `HEAD:${p}`])
  if (r.code !== 0) return ''
  return r.stdout
}

export function gitDiff(root: string, relPath: string): Promise<FileDiff> {
  return gitDiffWith(localGitHost(root), relPath)
}

export async function gitDiffWith(
  host: GitHost,
  relPath: string,
): Promise<FileDiff> {
  const safePath = normalizeGitRelativePath(relPath)
  if (!(await isGitRepo(host))) {
    throw new Error('Not a git repository')
  }
  // Resolve the status row by relative path so the client doesn't need to.
  const summary = await gitStatusWith(host)
  const entry = summary.entries.find(e => e.path === safePath) ?? null
  if (!entry) {
    return {
      path: safePath,
      status: 'modified',
      isBinary: false,
      oldContent: '',
      newContent: await host.readText(host.resolve(safePath), MAX_DIFF_BYTES),
      truncated: false,
    }
  }

  const absPath = entry.absPath
  const truncated = ((await host.size(absPath)) ?? 0) > MAX_DIFF_BYTES

  let oldContent = ''
  let newContent = ''

  if (entry.isBinary) {
    return {
      path: entry.path,
      status: entry.status,
      isBinary: true,
      oldContent: '',
      newContent: '',
      truncated,
    }
  }

  const readWorking = () => host.readText(absPath, MAX_DIFF_BYTES)
  switch (entry.status) {
    case 'untracked':
      newContent = await readWorking()
      break
    case 'deleted':
      oldContent = await readHead(host, entry.path)
      break
    case 'renamed':
      oldContent = entry.oldPath ? await readHead(host, entry.oldPath) : ''
      newContent = await readWorking()
      break
    case 'added':
    case 'modified':
    default:
      oldContent = await readHead(host, entry.path)
      newContent = await readWorking()
      break
  }

  return {
    path: entry.path,
    status: entry.status,
    isBinary: false,
    oldContent,
    newContent,
    truncated,
  }
}
