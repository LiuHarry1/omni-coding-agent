import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAppDirName } from '../utils/app-dir.js'
import { readSessionIndex } from './session-index.js'

describe('session index recovery', () => {
  let home = ''

  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true })
  })

  it('backs up a corrupt index and rebuilds it from transcripts', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-index-recovery-'))
    const appDir = path.join(home, getAppDirName())
    const projectDir = path.join(appDir, 'projects', 'cloud-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'session-1.jsonl'),
      `${JSON.stringify({
        type: 'session_created',
        id: 'session-1',
        createdAt: 1234,
        ownerEmail: 'alice@example.com',
      })}\n`,
    )
    fs.writeFileSync(path.join(appDir, 'session-index.json'), '{"broken":')

    expect(readSessionIndex(home).sessions['session-1']).toEqual({
      projectKey: 'cloud-project',
      createdAt: 1234,
      ownerEmail: 'alice@example.com',
    })
    expect(
      fs
        .readdirSync(appDir)
        .some(name => name.startsWith('session-index.json.corrupt.')),
    ).toBe(true)
  })
})
