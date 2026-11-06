import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAppDirName } from '../utils/app-dir.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import {
  displayPathFromCwd,
  readsFromAgentHost,
  writesToAgentHost,
} from './fs-route.js'

const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function withAgentHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-fs-route-'))
  cleanup.push(home)
  process.env.AUTH_ENABLED = 'true'
  return runWithRequestScope({ agentHome: home, cwd: '/workspace/repo' }, () =>
    fn(home),
  )
}

describe('readsFromAgentHost', () => {
  it('routes agent-host harness paths to the host', () => {
    withAgentHome(home => {
      const spill = path.join(
        home,
        getAppDirName(),
        'projects',
        'cloud-ws',
        'session',
        'tool-results',
        'toolu_x.txt',
      )
      expect(readsFromAgentHost(spill)).toBe(true)
      expect(readsFromAgentHost(path.dirname(spill))).toBe(true)
      expect(
        readsFromAgentHost(path.join(home, getAppDirName(), 'uploads', 's1')),
      ).toBe(true)
    })
  })

  it('leaves workspace, relative and other host paths to the workspace', () => {
    withAgentHome(home => {
      expect(readsFromAgentHost(undefined)).toBe(false)
      expect(readsFromAgentHost('')).toBe(false)
      expect(readsFromAgentHost('src/index.ts')).toBe(false)
      expect(readsFromAgentHost('~/notes.txt')).toBe(false)
      expect(readsFromAgentHost('/workspace/repo/src')).toBe(false)
      expect(readsFromAgentHost(path.join(home, 'other.txt'))).toBe(false)
      expect(
        readsFromAgentHost(
          path.join(home, getAppDirName(), 'projects-evil', 'x.txt'),
        ),
      ).toBe(false)
    })
  })
})

describe('writesToAgentHost', () => {
  it('routes only absolute paths under a host write root', () => {
    const plans = path.resolve(os.tmpdir(), 'home', '.ai-agent', 'plans')
    expect(writesToAgentHost(path.join(plans, 'calm-otter.md'), [plans])).toBe(
      true,
    )
    expect(writesToAgentHost(plans, [plans])).toBe(true)
    expect(writesToAgentHost(`${plans}-evil/x.md`, [plans])).toBe(false)
    expect(writesToAgentHost('plans/calm-otter.md', [plans])).toBe(false)
    expect(writesToAgentHost('/workspace/repo/a.md', [plans])).toBe(false)
    expect(writesToAgentHost(path.join(plans, 'a.md'), undefined)).toBe(false)
  })
})

describe('displayPathFromCwd', () => {
  it('is cwd-relative inside cwd and absolute outside it', () => {
    const cwd = path.resolve(os.tmpdir(), 'proj')
    expect(displayPathFromCwd(cwd, path.join(cwd, 'src', 'a.ts'))).toBe(
      'src/a.ts',
    )
    expect(displayPathFromCwd(cwd, path.join(cwd, '..foo', 'a.ts'))).toBe(
      '..foo/a.ts',
    )
    const outside = path.resolve(os.tmpdir(), 'elsewhere', 'b.txt')
    expect(displayPathFromCwd(cwd, outside)).toBe(outside.replaceAll('\\', '/'))
  })
})
