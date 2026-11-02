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

describe('skill env templates', () => {
  it('adds a missing .env and .env.example without overwriting an edited .env', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-seed-env-'))
    cleanup.push(parent)
    const seed = path.join(parent, 'seed')
    const workspace = path.join(parent, 'workspace')
    const template = 'TOKEN=example\n'
    fs.mkdirSync(
      path.join(seed, '.ai-agent', 'skills', 'weshare-manager'),
      { recursive: true },
    )
    fs.writeFileSync(
      path.join(seed, '.ai-agent', 'skills', 'weshare-manager', '.env.example'),
      template,
    )
    fs.mkdirSync(
      path.join(workspace, '.ai-agent', 'skills', 'weshare-manager'),
      { recursive: true },
    )
    fs.writeFileSync(
      path.join(workspace, WORKSPACE_SEEDED_MARKER),
      '{}\n',
    )
    process.env.WORKSPACE_SEED_DIR = seed

    expect(seedUserWorkspaceIfNeeded(workspace)).toBe(true)
    const skill = path.join(workspace, '.ai-agent', 'skills', 'weshare-manager')
    expect(fs.readFileSync(path.join(skill, '.env.example'), 'utf8')).toBe(
      template,
    )
    expect(fs.readFileSync(path.join(skill, '.env'), 'utf8')).toBe(template)

    fs.writeFileSync(path.join(skill, '.env'), 'TOKEN=real\n')
    expect(seedUserWorkspaceIfNeeded(workspace)).toBe(false)
    expect(fs.readFileSync(path.join(skill, '.env'), 'utf8')).toBe(
      'TOKEN=real\n',
    )
  })
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
