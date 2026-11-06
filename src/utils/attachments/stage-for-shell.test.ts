import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShellFsPort } from '../../execution/shell-fs.js'
import { getAppDirName } from '../app-dir.js'
import { createShellAttachmentStager } from './stage-for-shell.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(dir)
  return dir
}

describePosix('createShellAttachmentStager over a real shell', () => {
  it('stages uploads privately under the remote home', async () => {
    const remoteHome = tempDir('stage-home-')
    const hostDir = tempDir('stage-host-')
    const upload = path.join(hostDir, '0f0f-report.docx')
    fs.writeFileSync(upload, 'docx bytes')

    // A local `sh` with its own HOME stands in for the SSH host.
    const port = new ShellFsPort({
      spawn: script =>
        spawn('sh', ['-c', script], {
          stdio: 'pipe',
          env: { ...process.env, HOME: remoteHome },
        }),
    })
    const stage = createShellAttachmentStager(
      { environmentId: 'ssh:dev', cwd: '/home/dev/repo' },
      'sess-1',
      { openFs: async () => port },
    )

    const dest = await stage!(upload)

    const dir = path.join(remoteHome, getAppDirName(), 'uploads', 'sess-1')
    expect(dest).toBe(path.join(dir, '0f0f-report.docx'))
    expect(fs.readFileSync(dest, 'utf8')).toBe('docx bytes')
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })
})
