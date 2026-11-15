/**
 * Shell file-fd capture in tool mode.
 * Covers stdout/stderr merge, grandchild pipe hang avoidance, cwd trailer, timeout.
 *
 * Run:
 *   npx tsx src/tests/test-shell-file-fd.ts
 * Windows (Git Bash required for bash cases):
 *   npx tsx src/tests/test-shell-file-fd.ts
 */
import assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  closeShellOutputFdSync,
  openShellOutputFdSync,
  openShellOutputHandle,
  closeShellOutputHandle,
  runShellCommand,
} from '../utils/shell/spawn-shell.js'
import { findGitBashPath } from '../utils/shell/windows-paths.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
} from '../utils/bash/shellQuoting.js'

const isWindows = process.platform === 'win32'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-fd-test-'))
  try {
    return await fn(dir)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

async function testOpenFlagsWrite(): Promise<void> {
  await withTempDir(async dir => {
    const p1 = path.join(dir, 'out-async.txt')
    const handle = await openShellOutputHandle(p1)
    fs.writeSync(handle.fd, 'via-handle\n')
    await closeShellOutputHandle(handle)
    assert.equal(fs.readFileSync(p1, 'utf8'), 'via-handle\n')

    const p2 = path.join(dir, 'out-sync.txt')
    const fd = openShellOutputFdSync(p2)
    fs.writeSync(fd, 'via-sync\n')
    closeShellOutputFdSync(fd)
    assert.equal(fs.readFileSync(p2, 'utf8'), 'via-sync\n')
  })
  console.log('ok: openShellOutputHandle / FdSync write')
}

async function testEchoStdout(): Promise<void> {
  const r = await runShellCommand({
    shell: 'bash',
    command: 'echo file-fd-hello',
    cwd: process.cwd(),
    timeoutMs: 20_000,
  })
  assert.equal(r.code, 0, `exit ${r.code}: ${r.stdout}`)
  assert.match(r.stdout, /file-fd-hello/)
  assert.equal(r.stderr, '', 'file mode merges stderr into stdout')
  assert.ok(r.cwdAfter, 'cwdAfter should be set')
  console.log('ok: echo stdout via file fd')
}

async function testStdoutStderrMerged(): Promise<void> {
  const r = await runShellCommand({
    shell: 'bash',
    command: 'echo out-line; echo err-line 1>&2',
    cwd: process.cwd(),
    timeoutMs: 20_000,
  })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /out-line/)
  assert.match(r.stdout, /err-line/)
  assert.equal(r.stderr, '')
  console.log('ok: stdout+stderr merged into stdout')
}

async function testPipeModeKeepsStreams(): Promise<void> {
  const r = await runShellCommand({
    shell: 'bash',
    command: 'echo out-pipe; echo err-pipe 1>&2',
    cwd: process.cwd(),
    timeoutMs: 20_000,
    usePipeMode: true,
  })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /out-pipe/)
  assert.match(r.stderr, /err-pipe/)
  console.log('ok: pipe mode keeps stdout/stderr separate')
}

/**
 * Regression for file-fd vs pipe: background child must not hang the tool call.
 * If this times out or takes >>2s, file-fd wiring regressed to waiting on pipes.
 */
async function testBackgroundChildDoesNotHang(): Promise<void> {
  const started = Date.now()
  const r = await runShellCommand({
    shell: 'bash',
    command: 'sleep 999 & echo done-bg',
    cwd: process.cwd(),
    timeoutMs: 15_000,
  })
  const elapsed = Date.now() - started
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /done-bg/)
  assert.ok(
    elapsed < 5_000,
    `expected finish in <5s (got ${elapsed}ms) — grandchild may be holding pipes`,
  )
  console.log(`ok: sleep 999 & does not hang (${elapsed}ms)`)
}

async function testCwdTrailer(): Promise<void> {
  await withTempDir(async dir => {
    const sub = path.join(dir, 'subdir')
    fs.mkdirSync(sub)
    const quoted = dir.replace(/'/g, `'\\''`)
    const r = await runShellCommand({
      shell: 'bash',
      command: `cd '${quoted}/subdir' && pwd`,
      cwd: dir,
      timeoutMs: 20_000,
    })
    assert.equal(r.code, 0, r.stdout)
    assert.ok(r.cwdAfter, 'cwdAfter missing')

    // macOS: bash `pwd -P` → /private/var/...; Node realpath may keep /var/...
    const canon = (p: string) => {
      let x = fs.realpathSync(p)
      if (process.platform === 'darwin' && x.startsWith('/var/')) {
        x = '/private' + x
      }
      return x.replace(/\\/g, '/').toLowerCase()
    }
    assert.equal(
      canon(r.cwdAfter!),
      canon(sub),
      `cwdAfter=${r.cwdAfter} expected=${sub} stdout=${r.stdout}`,
    )
  })
  console.log('ok: cwd trailer after cd')
}

async function testTimeout(): Promise<void> {
  const started = Date.now()
  const r = await runShellCommand({
    shell: 'bash',
    command: 'sleep 30',
    cwd: process.cwd(),
    timeoutMs: 800,
  })
  const elapsed = Date.now() - started
  assert.ok(
    r.timedOut || r.interrupted,
    `expected timeout flags, got ${JSON.stringify(r)}`,
  )
  assert.ok(elapsed < 12_000, `timeout settle too slow: ${elapsed}ms`)
  console.log(`ok: timeout kills sleep (${elapsed}ms)`)
}

async function testProgressCallback(): Promise<void> {
  let ticks = 0
  const r = await runShellCommand({
    shell: 'bash',
    command: 'echo progress-a; sleep 0.2; echo progress-b',
    cwd: process.cwd(),
    timeoutMs: 20_000,
    progressIntervalMs: 50,
    onProgress: () => {
      ticks++
    },
  })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /progress-a/)
  assert.match(r.stdout, /progress-b/)
  assert.ok(ticks >= 1, 'expected at least one progress poll')
  console.log(`ok: onProgress polled (${ticks} ticks)`)
}

async function testPowerShellIfWindows(): Promise<void> {
  if (!isWindows) {
    console.log('skip: PowerShell (non-Windows)')
    return
  }
  const r = await runShellCommand({
    shell: 'powershell',
    command: "Write-Output 'ps-fd-ok'",
    cwd: process.cwd(),
    timeoutMs: 30_000,
  })
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /ps-fd-ok/)
  assert.equal(r.stderr, '')
  console.log('ok: PowerShell file-fd Write-Output')
}

function testRewriteWindowsNullRedirect(): void {
  assert.equal(rewriteWindowsNullRedirect('ls 2>nul'), 'ls 2>/dev/null')
  assert.equal(rewriteWindowsNullRedirect('ls 2> NUL'), 'ls 2> /dev/null')
  assert.equal(rewriteWindowsNullRedirect('echo x >nul'), 'echo x >/dev/null')
  assert.equal(
    rewriteWindowsNullRedirect('cat nul.txt'),
    'cat nul.txt',
    'must not rewrite a filename starting with nul',
  )
  assert.match(quoteShellCommand('echo hi'), /\/dev\/null/)
  assert.match(quoteShellCommand('echo a | wc -l'), /\/dev\/null/)
  console.log('ok: rewriteWindowsNullRedirect / quoteShellCommand')
}

async function testNulRedirectDoesNotCreateNulFile(): Promise<void> {
  await withTempDir(async dir => {
    const r = await runShellCommand({
      shell: 'bash',
      command: 'echo x 2>nul',
      cwd: dir,
      timeoutMs: 20_000,
    })
    assert.equal(r.code, 0, r.stdout)
    assert.equal(
      fs.existsSync(path.join(dir, 'nul')),
      false,
      'created a nul device file',
    )
    assert.equal(
      fs.existsSync(path.join(dir, 'NUL')),
      false,
      'created a NUL device file',
    )
  })
  console.log('ok: 2>nul rewritten, no nul file')
}

async function testPipeStillWorks(): Promise<void> {
  const r = await runShellCommand({
    shell: 'bash',
    command: 'printf "a\\nb\\n" | wc -l',
    cwd: process.cwd(),
    timeoutMs: 20_000,
  })
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /2/)
  console.log('ok: pipe + eval stdin redirect')
}

async function testHeredoc(): Promise<void> {
  const r = await runShellCommand({
    shell: 'bash',
    command: 'cat <<EOF\nheredoc-ok\nEOF',
    cwd: process.cwd(),
    timeoutMs: 20_000,
  })
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /heredoc-ok/)
  console.log('ok: heredoc via eval wrap')
}

async function testCmdCDoesNotHang(): Promise<void> {
  if (!isWindows) {
    console.log('skip: cmd.exe /c (non-Windows)')
    return
  }
  const started = Date.now()
  const r = await runShellCommand({
    shell: 'bash',
    command: 'cmd.exe /c echo cmd-ok',
    cwd: process.cwd(),
    timeoutMs: 12_000,
  })
  const elapsed = Date.now() - started
  assert.ok(
    elapsed < 10_000,
    `cmd.exe /c hung ${elapsed}ms — stdin redirect missing?`,
  )
  assert.ok(!r.timedOut, `cmd.exe /c timed out (${elapsed}ms)`)
  console.log(`ok: cmd.exe /c settled in ${elapsed}ms code=${r.code}`)
}

async function main(): Promise<void> {
  if (isWindows) {
    const gitBash = findGitBashPath()
    if (!gitBash) {
      console.error(
        'FAIL: Git Bash not found. Install Git for Windows or set GIT_BASH_PATH, then re-run.',
      )
      process.exit(1)
    }
    console.log(`Git Bash: ${gitBash}`)
  }

  testRewriteWindowsNullRedirect()
  await testOpenFlagsWrite()
  await testEchoStdout()
  await testStdoutStderrMerged()
  await testPipeModeKeepsStreams()
  await testBackgroundChildDoesNotHang()
  await testCwdTrailer()
  await testTimeout()
  await testProgressCallback()
  await testPowerShellIfWindows()
  await testNulRedirectDoesNotCreateNulFile()
  await testPipeStillWorks()
  await testHeredoc()
  await testCmdCDoesNotHang()

  console.log('\nAll shell file-fd tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
