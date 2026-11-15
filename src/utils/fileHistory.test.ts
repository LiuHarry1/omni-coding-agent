import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSessionDataDir, registerSessionLocation } from '../session/paths.js'
import {
  MAX_SNAPSHOTS,
  fileHistoryCanRestore,
  fileHistoryChangedFiles,
  fileHistoryCopy,
  fileHistoryCreatedFiles,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
} from './fileHistory.js'

let agentHome: string
let cwd: string
let sessionId: string

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'file-history-home-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'file-history-cwd-'))
  sessionId = `file-history-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  fs.rmSync(agentHome, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

/** What the edit tools do: back up, then write. */
function write(file: string, content: string, id = sessionId) {
  fileHistoryTrackEdit(id, file)
  fs.writeFileSync(file, content)
}

describe('file history', () => {
  it('puts files back the way they were when a message was sent', () => {
    const a = path.join(cwd, 'a.txt')
    const b = path.join(cwd, 'b.txt')
    fs.writeFileSync(a, 'a0')

    fileHistoryMakeSnapshot(sessionId, 'm1')
    write(a, 'a1')
    write(a, 'a1b')
    fileHistoryMakeSnapshot(sessionId, 'm2')
    write(a, 'a2')
    write(b, 'b2')

    expect(fileHistoryChangedFiles(sessionId, 'm2').sort()).toEqual([a, b])
    expect(fileHistoryRewind(sessionId, 'm2')).toEqual({
      restored: [a],
      deleted: [b],
    })
    expect(fs.readFileSync(a, 'utf8')).toBe('a1b')
    expect(fs.existsSync(b)).toBe(false)
    expect(fileHistoryCanRestore(sessionId, 'm2')).toBe(false)

    fileHistoryRewind(sessionId, 'm1')
    expect(fs.readFileSync(a, 'utf8')).toBe('a0')
  })

  it('takes the content from before the first change after the message', () => {
    const a = path.join(cwd, 'a.txt')
    fs.writeFileSync(a, 'a0')
    fileHistoryMakeSnapshot(sessionId, 'm1')
    fileHistoryMakeSnapshot(sessionId, 'm2')
    write(a, 'a2')
    fileHistoryRewind(sessionId, 'm1')
    expect(fs.readFileSync(a, 'utf8')).toBe('a0')
  })

  it('says which files a rewind would delete', () => {
    const a = path.join(cwd, 'a.txt')
    const b = path.join(cwd, 'b.txt')
    const c = path.join(cwd, 'c.txt')
    fs.writeFileSync(a, 'a0')
    fileHistoryMakeSnapshot(sessionId, 'm1')
    write(a, 'a1')
    write(b, 'b1')
    write(c, 'c1')
    // Gone again already: nothing left to delete.
    fs.rmSync(c)
    expect(fileHistoryCreatedFiles(sessionId, 'm1')).toEqual([b])
  })

  it('deletes the backups of the snapshots a rewind drops', () => {
    const a = path.join(cwd, 'a.txt')
    fs.writeFileSync(a, 'a0')
    fileHistoryMakeSnapshot(sessionId, 'm1')
    write(a, 'a1')
    fileHistoryMakeSnapshot(sessionId, 'm2')
    write(a, 'a2')
    const dir = path.join(getSessionDataDir(sessionId), 'file-history')
    const backups = () => fs.readdirSync(dir).filter(f => f !== 'index.json')
    expect(backups()).toHaveLength(2)

    fileHistoryRewind(sessionId, 'm2')
    expect(backups()).toHaveLength(1)
    // What m1 needs is still there.
    fileHistoryRewind(sessionId, 'm1')
    expect(fs.readFileSync(a, 'utf8')).toBe('a0')
    expect(backups()).toHaveLength(0)
  })

  it('tracks nothing before the first snapshot', () => {
    const a = path.join(cwd, 'a.txt')
    write(a, 'a0')
    expect(fileHistoryCanRestore(sessionId, 'm1')).toBe(false)
    expect(() => fileHistoryRewind(sessionId, 'm1')).toThrow(/no file snapshot/)
  })

  it(`keeps the last ${MAX_SNAPSHOTS} snapshots`, () => {
    const a = path.join(cwd, 'a.txt')
    for (let i = 0; i <= MAX_SNAPSHOTS; i++) {
      fileHistoryMakeSnapshot(sessionId, `m${i}`)
      write(a, `a${i}`)
    }
    expect(fileHistoryCanRestore(sessionId, 'm0')).toBe(false)
    expect(fileHistoryCanRestore(sessionId, 'm1')).toBe(true)
    fileHistoryRewind(sessionId, 'm1')
    expect(fs.readFileSync(a, 'utf8')).toBe('a0')
  })

  it('gives a fork the snapshots from before the fork point', () => {
    const a = path.join(cwd, 'a.txt')
    fs.writeFileSync(a, 'a0')
    fileHistoryMakeSnapshot(sessionId, 'm1')
    write(a, 'a1')
    fileHistoryMakeSnapshot(sessionId, 'm2')
    write(a, 'a2')

    const fork = `${sessionId}-fork`
    registerSessionLocation(fork, { projectKey: 'project', agentHome })
    fileHistoryCopy(sessionId, fork, 'm2')
    expect(fileHistoryCanRestore(fork, 'm1')).toBe(true)
    expect(fileHistoryCanRestore(fork, 'm2')).toBe(false)
    fileHistoryRewind(fork, 'm1')
    expect(fs.readFileSync(a, 'utf8')).toBe('a0')
  })
})
