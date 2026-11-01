import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  remotePathShell,
  ShellFsError,
  ShellFsPort,
  type ShellHost,
} from './shell-fs.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

/** The same scripts SSH and `docker exec` run, against a local `sh`. */
const localShell: ShellHost = {
  spawn: script => spawn('sh', ['-c', script], { stdio: 'pipe' }),
}

describe('remotePathShell', () => {
  it('expands only explicit HOME forms and preserves path whitespace', () => {
    expect(remotePathShell('~')).toBe('"$HOME"')
    expect(remotePathShell('~/notes ')).toBe(`"$HOME"/'notes '`)
    expect(remotePathShell('')).toBe("''")
    expect(remotePathShell(' ')).toBe("' '")
    expect(remotePathShell('/tmp/file ')).toBe("'/tmp/file '")
  })
})

describePosix('ShellFsPort writes', () => {
  let dir: string
  let port: ShellFsPort

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-fs-')))
    port = new ShellFsPort(localShell)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const code = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      e => e,
    )
    expect(err).toBeInstanceOf(ShellFsError)
    return (err as ShellFsError).code
  }

  it('creates exclusively and needs an existing parent', async () => {
    const p = path.join(dir, 'a.txt')
    await port.writeFile(p, Buffer.from('one'), { exclusive: true })
    expect(fs.readFileSync(p, 'utf8')).toBe('one')
    expect(
      await code(port.writeFile(p, Buffer.from('two'), { exclusive: true })),
    ).toBe('EEXIST')
    expect(
      await code(port.writeFile(path.join(dir, 'no/b.txt'), Buffer.from('x'))),
    ).toBe('ENOENT')
    expect(await code(port.writeFile(dir, Buffer.from('x')))).toBe('EISDIR')
    expect(fs.readdirSync(dir)).toEqual(['a.txt'])
  })

  it('overwrites in place, keeping the file mode', async () => {
    const p = path.join(dir, 'run.sh')
    fs.writeFileSync(p, 'old')
    fs.chmodSync(p, 0o755)
    await port.writeFile(p, Buffer.from('#!/bin/sh\necho new\n'))
    expect(fs.readFileSync(p, 'utf8')).toBe('#!/bin/sh\necho new\n')
    expect(fs.statSync(p).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(dir)).toEqual(['run.sh'])
  })

  it('publishes atomic config writes without following symlinks', async () => {
    const p = path.join(dir, 'config.md')
    await port.writeFileAtomic(p, Buffer.from('one'), {
      createOnly: true,
      mode: 0o640,
    })
    const first = await port.stat(p)
    await port.writeFileAtomic(p, Buffer.from('two'), {
      requireExisting: true,
      expectedMtimeMs: first.mtimeMs,
    })
    expect(fs.readFileSync(p, 'utf8')).toBe('two')
    expect(fs.statSync(p).mode & 0o777).toBe(0o640)
    expect(
      await code(
        port.writeFileAtomic(p, Buffer.from('duplicate'), {
          createOnly: true,
        }),
      ),
    ).toBe('EEXIST')

    const outside = path.join(dir, 'outside.md')
    const link = path.join(dir, 'link.md')
    fs.writeFileSync(outside, 'keep')
    fs.symlinkSync(outside, link)
    expect(
      await code(
        port.writeFileAtomic(link, Buffer.from('blocked'), {
          requireExisting: true,
        }),
      ),
    ).toBe('ESYMLINK')
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
  })

  it('round-trips binary streams and multi-byte text larger than a pipe chunk', async () => {
    const bin = Buffer.alloc(300_000)
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 31) % 256
    const binPath = path.join(dir, 'blob.bin')
    await port.writeFile(
      binPath,
      Readable.from([bin.subarray(0, 1000), bin.subarray(1000)]),
    )
    expect(Buffer.compare(fs.readFileSync(binPath), bin)).toBe(0)
    expect(Buffer.compare(Buffer.from(await port.read(binPath)), bin)).toBe(0)

    const text = '你好，世界 ✓ '.repeat(20_000)
    const textPath = path.join(dir, '中文.md')
    await port.writeFile(textPath, Buffer.from(text, 'utf8'))
    expect(await port.read(textPath, { encoding: 'utf-8' })).toBe(text)
    expect((await port.readHead(textPath, 6)).toString('utf8')).toBe('你好')
  })

  it('reports mtime and size the way stat does', async () => {
    const p = path.join(dir, 'm.txt')
    fs.writeFileSync(p, 'hello')
    const st = await port.stat(p)
    expect(st).toMatchObject({ type: 'file', size: 5, path: p })
    expect(Math.abs((st.mtimeMs ?? 0) - fs.statSync(p).mtimeMs)).toBeLessThan(1)
    expect(await code(port.stat(path.join(dir, 'missing')))).toBe('ENOENT')
  })

  it('does not publish a failed temp write', async () => {
    const p = path.join(dir, 'config.md')
    fs.writeFileSync(p, 'keep')
    const failing = new ShellFsPort({
      spawn: script =>
        spawn('sh', ['-c', script.replace('cat > "$t"', 'false > "$t"')], {
          stdio: 'pipe',
        }),
    })

    expect(
      await code(
        failing.writeFileAtomic(p, Buffer.from('partial'), {
          requireExisting: true,
          expectedMtimeMs: (await failing.stat(p)).mtimeMs,
        }),
      ),
    ).toBe('EIO')
    expect(fs.readFileSync(p, 'utf8')).toBe('keep')
    expect(fs.readdirSync(dir)).toEqual(['config.md'])
  })

  it('serializes same-path saves and rejects the stale revision', async () => {
    const p = path.join(dir, 'race.md')
    fs.writeFileSync(p, 'original')
    const past = new Date(Date.now() - 10_000)
    fs.utimesSync(p, past, past)
    const expectedMtimeMs = (await port.stat(p)).mtimeMs

    const results = await Promise.allSettled([
      port.writeFileAtomic(p, Buffer.from('first'), {
        requireExisting: true,
        expectedMtimeMs,
      }),
      port.writeFileAtomic(p, Buffer.from('second'), {
        requireExisting: true,
        expectedMtimeMs,
      }),
    ])

    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'EMTIME',
    })
    expect(['first', 'second']).toContain(fs.readFileSync(p, 'utf8'))
  })

  it('rechecks the revision immediately before publishing', async () => {
    const p = path.join(dir, 'external.md')
    fs.writeFileSync(p, 'original')
    const past = new Date(Date.now() - 10_000)
    fs.utimesSync(p, past, past)
    const expectedMtimeMs = (await port.stat(p)).mtimeMs
    const input = new PassThrough()
    const saving = port.writeFileAtomic(p, input, {
      requireExisting: true,
      expectedMtimeMs,
    })

    input.write('draft')
    await new Promise(resolve => setTimeout(resolve, 30))
    fs.writeFileSync(p, 'external')
    input.end(' remainder')

    expect(await code(saving)).toBe('EMTIME')
    expect(fs.readFileSync(p, 'utf8')).toBe('external')
  })

  it('mkdir -p is idempotent and refuses files', async () => {
    const nested = path.join(dir, 'x/y/z')
    await port.mkdir(nested)
    await port.mkdir(nested)
    expect(fs.statSync(nested).isDirectory()).toBe(true)
    fs.writeFileSync(path.join(dir, 'f'), '')
    expect(await code(port.mkdir(path.join(dir, 'f')))).toBe('EEXIST')
  })

  it('removes files and trees', async () => {
    fs.mkdirSync(path.join(dir, 't/u'), { recursive: true })
    fs.writeFileSync(path.join(dir, 't/u/v.txt'), 'v')
    fs.writeFileSync(path.join(dir, "it's.txt"), 'q')
    await port.remove(path.join(dir, "it's.txt"))
    await port.remove(path.join(dir, 't'))
    expect(fs.readdirSync(dir)).toEqual([])
    expect(await code(port.remove(path.join(dir, 't')))).toBe('ENOENT')
  })

  it('preserves trailing spaces and refuses blank, HOME, and root deletes', async () => {
    const spaced = path.join(dir, 'trailing ')
    fs.writeFileSync(spaced, 'value')
    await port.remove(spaced)
    expect(fs.existsSync(spaced)).toBe(false)

    expect(await code(port.remove(' '))).toBe('EINVAL')
    expect(await code(port.remove('~'))).toBe('EINVAL')
    expect(await code(port.remove('$HOME'))).toBe('EINVAL')
    expect(await code(port.remove('/'))).toBe('EINVAL')
  })
})
