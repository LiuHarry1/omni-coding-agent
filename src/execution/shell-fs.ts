import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type { Readable } from 'stream'
import type { DirEntry, FileStat, FsPort, ReadOpts } from './types.js'

/** A POSIX `sh` reachable through a child process (SSH, `docker exec`). */
export interface ShellHost {
  /** Start `sh -c <script>` with piped stdin, stdout and stderr. */
  spawn(script: string): ChildProcess
  /** Awaited before every script, e.g. to start a stopped container. */
  ready?(): Promise<void>
}

export type ShellResult = {
  stdout: Buffer
  stderr: string
  code: number | null
}

export type ShellRunOptions = {
  /** Bytes or a stream piped to the script's stdin. */
  input?: Buffer | Readable
  timeoutMs?: number
}

/** Run a script to completion. Resolves with the exit code instead of throwing. */
export function runShell(
  host: ShellHost,
  script: string,
  opts: ShellRunOptions = {},
): Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  return new Promise((resolve, reject) => {
    const child = host.spawn(script)
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
      })
    })
    const stdin = child.stdin
    if (!stdin) return
    // A script that exits before draining stdin closes the pipe; that's its
    // exit code's business, not an error here.
    stdin.on('error', () => {})
    if (!opts.input) stdin.end()
    else if (Buffer.isBuffer(opts.input)) stdin.end(opts.input)
    else opts.input.pipe(stdin)
  })
}

/** Escape for single-quoted remote shell string. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

/**
 * Build a remote shell expression for a path.
 * Bare `~` / `~/…` must NOT be fully single-quoted or tilde never expands
 * (that caused HTTP 500 ERR:not_a_dir when browsing SSH hosts).
 */
export function remotePathShell(filePath: string): string {
  const p = filePath
  if (p === '~') return '"$HOME"'
  if (p.startsWith('~/')) {
    return `"$HOME"/${shQuote(p.slice(2))}`
  }
  if (p === '$HOME') return '"$HOME"'
  if (p.startsWith('$HOME/')) {
    return `"$HOME"/${shQuote(p.slice('$HOME/'.length))}`
  }
  return shQuote(p)
}

/** GNU stat exposes nanoseconds; BSD falls back to whole-second precision. */
const SHELL_MTIME_MS_FUNCTION = `
mtime_ms() {
  _mtime_path=$1
  _mtime_detail=$(stat -c %y "$_mtime_path" 2>/dev/null || true)
  if [ -n "$_mtime_detail" ]; then
    _mtime_seconds=$(stat -c %Y "$_mtime_path" 2>/dev/null || echo 0)
    _mtime_fraction=$(printf '%s' "$_mtime_detail" | sed -n 's/^[^.]*\\.\\([0-9][0-9]*\\).*/\\1/p')
  else
    _mtime_detail=$(stat -f %Fm "$_mtime_path" 2>/dev/null || echo 0)
    _mtime_seconds=\${_mtime_detail%%.*}
    case "$_mtime_detail" in
      *.*) _mtime_fraction=\${_mtime_detail#*.} ;;
      *) _mtime_fraction= ;;
    esac
  fi
  if [ -n "$_mtime_fraction" ]; then
    _mtime_fraction=$(printf '%.3s' "\${_mtime_fraction}000")
  else
    _mtime_fraction=000
  fi
  printf '%s%s\\n' "$_mtime_seconds" "$_mtime_fraction"
}
`

export type ShellFsErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'EACCES'
  | 'EINVAL'
  | 'ESYMLINK'
  | 'ESPECIAL'
  | 'EMTIME'
  | 'EIO'

export class ShellFsError extends Error {
  constructor(
    readonly code: ShellFsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ShellFsError'
  }
}

/** Exit status scripts use to report `ERR:<code>` on stdout. */
const ERR_EXIT = 3

const ERR_CODES = new Set<ShellFsErrorCode>([
  'ENOENT',
  'EEXIST',
  'EISDIR',
  'ENOTDIR',
  'EACCES',
  'EINVAL',
  'ESYMLINK',
  'ESPECIAL',
  'EMTIME',
])

export type ShellPathInfo = {
  path: string
  type: 'missing' | 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  mode: number
}

/**
 * FsPort for environments reachable only through a shell (SSH, `docker exec`).
 * Paths are POSIX paths on the remote side.
 */
export class ShellFsPort implements FsPort {
  private writeLocks = new Map<string, Promise<void>>()

  constructor(private host: ShellHost) {}

  private async withWriteLock<T>(
    filePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.writeLocks.get(filePath) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const queued = previous.catch(() => {}).then(() => gate)
    this.writeLocks.set(filePath, queued)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.writeLocks.get(filePath) === queued) {
        this.writeLocks.delete(filePath)
      }
    }
  }

  /** Run a script in the environment; never throws on a non-zero exit. */
  async run(script: string, opts?: ShellRunOptions): Promise<ShellResult> {
    await this.host.ready?.()
    return runShell(this.host, script, opts)
  }

  /** Start a script whose stdout the caller streams (downloads). */
  async spawn(script: string): Promise<ChildProcess> {
    await this.host.ready?.()
    return this.host.spawn(script)
  }

  private async exec(
    script: string,
    target: string,
    opts?: ShellRunOptions,
  ): Promise<Buffer> {
    const { stdout, stderr, code } = await this.run(script, opts)
    if (code === 0) return stdout
    const head = stdout.subarray(0, 64).toString('utf8')
    const reported = /^ERR:([A-Z]+)/.exec(head)?.[1] as
      ShellFsErrorCode | undefined
    if (code === ERR_EXIT && reported && ERR_CODES.has(reported)) {
      throw new ShellFsError(reported, `${reported}: ${target}`)
    }
    const detail = stderr.trim() || `exit ${code}`
    throw new ShellFsError(
      /permission denied/i.test(detail) ? 'EACCES' : 'EIO',
      `${detail} (${target})`,
    )
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    const { dir, entries } = await this.listResolved(dirPath)
    // Preserve resolved dir for callers that only use list()
    Object.defineProperty(entries, 'resolvedDir', {
      value: dir,
      enumerable: false,
    })
    return entries
  }

  async listResolved(
    dirPath: string,
  ): Promise<{ dir: string; entries: DirEntry[] }> {
    const expr = remotePathShell(dirPath)
    const script = `
set -e
d=${expr}
if [ ! -d "$d" ]; then
  echo "ERR:ENOTDIR"
  exit ${ERR_EXIT}
fi
d=$(cd "$d" && pwd -P)
echo "DIR:$d"
for e in "$d"/.* "$d"/*; do
  [ -e "$e" ] || continue
  base=$(basename "$e")
  [ "$base" = "." ] || [ "$base" = ".." ] && continue
  if [ -d "$e" ]; then t=d
  elif [ -f "$e" ]; then t=f
  else t=o; fi
  printf '%s\\t%s\\n' "$base" "$t"
done
`
    let out: string
    try {
      out = (await this.exec(script, dirPath)).toString('utf8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Cannot list remote directory "${dirPath}": ${msg}. ` +
          `Hint: use an absolute path or ~/… (home is expanded on the remote).`,
        { cause: err },
      )
    }

    let resolvedDir = dirPath
    const entries: DirEntry[] = []
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (line.startsWith('DIR:')) {
        resolvedDir = line.slice(4).trim() || resolvedDir
        continue
      }
      const [name, y] = line.split('\t')
      if (!name || name === '.' || name === '..') continue
      const type: DirEntry['type'] =
        y === 'd' ? 'dir' : y === 'f' ? 'file' : 'other'
      entries.push({
        name,
        path: `${resolvedDir.replace(/\/$/, '')}/${name}`,
        type,
      })
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { dir: resolvedDir, entries }
  }

  async stat(filePath: string): Promise<FileStat> {
    const expr = remotePathShell(filePath)
    const script = `
${SHELL_MTIME_MS_FUNCTION}
p=${expr}
if [ ! -e "$p" ]; then echo 'ERR:ENOENT'; exit ${ERR_EXIT}; fi
if [ -d "$p" ]; then
  t=dir
  rp=$(cd "$p" && pwd -P)
else
  [ -f "$p" ] && t=file || t=other
  rp=$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")
fi
size=$(wc -c < "$p" 2>/dev/null || echo 0)
mtime=$(mtime_ms "$p")
printf '%s\\t%s\\t%s\\t%s\\n' "$t" "$size" "$mtime" "$rp"
`
    const out = (await this.exec(script, filePath)).toString('utf8').trim()
    const [type, size, mtime, resolved] = out.split('\t')
    return {
      path: resolved || filePath,
      type: (type as FileStat['type']) || 'other',
      size: Number(size) || 0,
      mtimeMs: Number(mtime) || 0,
    }
  }

  /** `lstat`-style metadata used by sandboxed config storage. */
  async inspectPath(filePath: string): Promise<ShellPathInfo> {
    const expr = remotePathShell(filePath)
    const script = `
${SHELL_MTIME_MS_FUNCTION}
p=${expr}
if [ -L "$p" ]; then
  t=symlink
elif [ ! -e "$p" ]; then
  printf 'missing\\t0\\t0\\t0\\n'
  exit 0
elif [ -d "$p" ]; then
  t=dir
elif [ -f "$p" ]; then
  t=file
else
  t=other
fi
if [ "$t" = file ]; then size=$(wc -c < "$p" 2>/dev/null || echo 0); else size=0; fi
mtime=$(mtime_ms "$p")
mode=$(stat -c %a "$p" 2>/dev/null || stat -f %Lp "$p" 2>/dev/null || echo 0)
printf '%s\\t%s\\t%s\\t%s\\n' "$t" "$size" "$mtime" "$mode"
`
    const out = (await this.exec(script, filePath)).toString('utf8').trim()
    const [type, size, mtime, mode] = out.split('\t')
    return {
      path: filePath,
      type: (type as ShellPathInfo['type']) || 'other',
      size: Number(size) || 0,
      mtimeMs: Number(mtime) || 0,
      mode: Number.parseInt(mode || '0', 8) || 0,
    }
  }

  async read(filePath: string, opts?: ReadOpts): Promise<Uint8Array | string> {
    const buf = await this.exec(`cat ${remotePathShell(filePath)}`, filePath)
    return opts?.encoding ? buf.toString('utf8') : buf
  }

  /** First `maxBytes` of a file. */
  async readHead(filePath: string, maxBytes: number): Promise<Buffer> {
    return this.exec(
      `head -c ${Math.max(0, Math.floor(maxBytes))} ${remotePathShell(filePath)}`,
      filePath,
    )
  }

  async realpath(filePath: string): Promise<string> {
    const expr = remotePathShell(filePath)
    const out = await this.exec(
      `p=${expr}; if [ -d "$p" ]; then cd "$p" && pwd -P; elif [ -e "$p" ]; then cd "$(dirname "$p")" && echo "$(pwd -P)/$(basename "$p")"; else echo ${shQuote(filePath)}; fi`,
      filePath,
    )
    return out.toString('utf8').trim().split(/\r?\n/)[0] || filePath
  }

  /**
   * Write a file from bytes or a stream. The parent directory must exist.
   * Data lands in a temp file first; an existing file is then overwritten in
   * place so its mode and inode survive (executable scripts stay executable).
   */
  async writeFile(
    filePath: string,
    data: Buffer | Readable,
    opts: { exclusive?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    const script = `
p=${remotePathShell(filePath)}
d=$(dirname "$p")
[ -d "$d" ] || { echo ERR:ENOENT; exit ${ERR_EXIT}; }
if [ -e "$p" ]; then
  [ -d "$p" ] && { echo ERR:EISDIR; exit ${ERR_EXIT}; }
  ${opts.exclusive ? `echo ERR:EEXIST; exit ${ERR_EXIT}` : ':'}
fi
t="$d/.$(basename "$p").$$.tmp"
cat > "$t" || { rm -f "$t"; exit 1; }
if [ -e "$p" ]; then
  cat "$t" > "$p" || { rm -f "$t"; exit 1; }
  rm -f "$t"
else
  mv -f "$t" "$p" || { rm -f "$t"; exit 1; }
fi
`
    await this.exec(script, filePath, {
      input: data,
      timeoutMs: opts.timeoutMs,
    })
  }

  /**
   * Publish bytes with a same-directory temporary file. Unlike `writeFile`,
   * replacement uses rename so readers never observe a partially written
   * config file.
   */
  async writeFileAtomic(
    filePath: string,
    data: Buffer | Readable,
    opts: {
      createOnly?: boolean
      requireExisting?: boolean
      expectedMtimeMs?: number
      mode?: number
      timeoutMs?: number
    } = {},
  ): Promise<void> {
    return this.withWriteLock(filePath, async () => {
      if (
        opts.expectedMtimeMs !== undefined &&
        (!Number.isFinite(opts.expectedMtimeMs) || opts.expectedMtimeMs < 0)
      ) {
        throw new ShellFsError('EINVAL', `Invalid mtime: ${filePath}`)
      }
      const expectedMtime =
        opts.expectedMtimeMs === undefined
          ? ''
          : String(Math.trunc(opts.expectedMtimeMs))
      const requestedMode =
        opts.mode === undefined ? '' : (opts.mode & 0o777).toString(8)
      const chmodCommand = requestedMode
        ? `chmod ${shQuote(requestedMode)} "$t"`
        : 'chmod "$old_mode" "$t"'
      const suffix = randomUUID().replace(/-/g, '')
      const script = `
${SHELL_MTIME_MS_FUNCTION}
p=${remotePathShell(filePath)}
d=$(dirname "$p")
[ -L "$d" ] && { echo ERR:ESYMLINK; exit ${ERR_EXIT}; }
[ -d "$d" ] || { echo ERR:ENOENT; exit ${ERR_EXIT}; }
[ -L "$p" ] && { echo ERR:ESYMLINK; exit ${ERR_EXIT}; }
exists=0
if [ -e "$p" ]; then
  exists=1
  [ -f "$p" ] || { echo ERR:ESPECIAL; exit ${ERR_EXIT}; }
fi
${opts.createOnly ? '[ "$exists" -eq 0 ] || { echo ERR:EEXIST; exit ' + ERR_EXIT + '; }' : ':'}
${opts.requireExisting ? '[ "$exists" -eq 1 ] || { echo ERR:ENOENT; exit ' + ERR_EXIT + '; }' : ':'}
if [ "$exists" -eq 1 ]; then
  current_mtime=$(mtime_ms "$p")
  ${expectedMtime ? `[ "$current_mtime" = ${shQuote(expectedMtime)} ] || { echo ERR:EMTIME; exit ${ERR_EXIT}; }` : ':'}
  old_mode=$(stat -c %a "$p" 2>/dev/null || stat -f %Lp "$p" 2>/dev/null || echo 600)
else
  old_mode=${shQuote(requestedMode || '600')}
fi
t="$d/.$(basename "$p").${suffix}.tmp"
[ ! -e "$t" ] && [ ! -L "$t" ] || { echo ERR:EEXIST; exit ${ERR_EXIT}; }
umask 077
( set -C; : > "$t" ) 2>/dev/null || { echo ERR:EEXIST; exit ${ERR_EXIT}; }
trap 'rm -f "$t"' EXIT HUP INT TERM
cat > "$t" || { rm -f "$t"; exit 1; }
${chmodCommand} || { rm -f "$t"; exit 1; }
if [ ${opts.createOnly ? '1' : '0'} -eq 1 ]; then
  ln "$t" "$p" 2>/dev/null || {
    [ -e "$p" ] || [ -L "$p" ] && echo ERR:EEXIST || echo ERR:EACCES
    exit ${ERR_EXIT}
  }
  rm -f "$t"
else
  if [ "$exists" -eq 1 ]; then
    [ -L "$p" ] && { echo ERR:ESYMLINK; exit ${ERR_EXIT}; }
    [ -f "$p" ] || { echo ERR:ENOENT; exit ${ERR_EXIT}; }
    ${expectedMtime ? `current_mtime=$(mtime_ms "$p"); [ "$current_mtime" = ${shQuote(expectedMtime)} ] || { echo ERR:EMTIME; exit ${ERR_EXIT}; }` : ':'}
  fi
  mv -f "$t" "$p" || { rm -f "$t"; exit 1; }
fi
trap - EXIT HUP INT TERM
`
      await this.exec(script, filePath, {
        input: data,
        timeoutMs: opts.timeoutMs,
      })
    })
  }

  /** `mkdir -p`; an existing directory is fine, an existing file is EEXIST. */
  async mkdir(dirPath: string): Promise<void> {
    const script = `
p=${remotePathShell(dirPath)}
if [ -e "$p" ]; then
  [ -d "$p" ] && exit 0
  echo ERR:EEXIST; exit ${ERR_EXIT}
fi
mkdir -p "$p"
`
    await this.exec(script, dirPath)
  }

  /** Remove a file or a directory tree. */
  async remove(targetPath: string): Promise<void> {
    if (!targetPath || targetPath.trim().length === 0) {
      throw new ShellFsError('EINVAL', 'Refusing to remove a blank path')
    }
    const script = `
p=${remotePathShell(targetPath)}
[ -e "$p" ] || [ -L "$p" ] || { echo ERR:ENOENT; exit ${ERR_EXIT}; }
home=$(cd "$HOME" && pwd -P) || { echo ERR:EACCES; exit ${ERR_EXIT}; }
if [ -L "$p" ]; then
  parent=$(cd "$(dirname "$p")" && pwd -P) || { echo ERR:EACCES; exit ${ERR_EXIT}; }
  r="$parent/$(basename "$p")"
elif [ -d "$p" ]; then
  r=$(cd "$p" && pwd -P) || { echo ERR:EACCES; exit ${ERR_EXIT}; }
else
  parent=$(cd "$(dirname "$p")" && pwd -P) || { echo ERR:EACCES; exit ${ERR_EXIT}; }
  r="$parent/$(basename "$p")"
fi
# POSIX lets pwd print "//" for the root; BSD rm only refuses a literal "/".
case "$r" in *[!/]*) ;; *) echo ERR:EINVAL; exit ${ERR_EXIT} ;; esac
[ "$r" != "$home" ] || { echo ERR:EINVAL; exit ${ERR_EXIT}; }
rm -rf -- "$p"
`
    await this.exec(script, targetPath)
  }

  async close(): Promise<void> {}
}
