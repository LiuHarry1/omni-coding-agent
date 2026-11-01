import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  seedUserWorkspaceIfNeeded,
  WORKSPACE_SEEDED_MARKER,
} from './workspace-seed.js'

const previousSeedDir = process.env.WORKSPACE_SEED_DIR
const cleanup: string[] = []

afterEach(() => {
  if (previousSeedDir === undefined) {
    delete process.env.WORKSPACE_SEED_DIR
  } else {
    process.env.WORKSPACE_SEED_DIR = previousSeedDir
  }
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('workspace seed disablement', () => {
  it('does not write a marker when WORKSPACE_SEED_DIR is explicitly disabled', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-seed-off-'))
    cleanup.push(parent)
    const remoteOnlyCwd = path.join(parent, 'missing-container-cwd')
    process.env.WORKSPACE_SEED_DIR = ''

    expect(seedUserWorkspaceIfNeeded(remoteOnlyCwd)).toBe(false)
    expect(
      fs.existsSync(path.join(remoteOnlyCwd, WORKSPACE_SEEDED_MARKER)),
    ).toBe(false)
  })
})
