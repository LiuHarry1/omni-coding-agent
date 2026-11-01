import * as fsSync from 'fs'
import { promises as fs } from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'
import * as archiverModule from 'archiver'
import type { Archiver } from 'archiver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  getUserConfigGeneration,
  USER_CONFIG_GENERATION_FILE,
} from '../../services/user-config-generation.js'
import {
  installMarketplaceArtifact,
  SKILL_PACKAGE_LIMITS,
  uninstallMarketplaceArtifact,
} from '../marketplace/installer.js'
import type { MarketplaceProviderConfig } from '../../core/types.js'
import { createUserConfigRouter } from './router.js'

const ZipArchive = (
  archiverModule as unknown as { ZipArchive: new () => Archiver }
).ZipArchive

const previousAuth = process.env.AUTH_ENABLED
const previousAppDir = process.env.AI_AGENT_DIR

let tempRoot: string
let homes: Record<string, string>
let server: http.Server
let baseURL: string

function home(user = 'alice'): string {
  return homes[user]!
}

function appDir(user = 'alice'): string {
  return path.join(home(user), '.ai-agent')
}

async function startServer(): Promise<void> {
  const router = createUserConfigRouter()
  server = http.createServer((req, res) => {
    const rawUser = req.headers['x-test-user']
    const user = (Array.isArray(rawUser) ? rawUser[0] : rawUser) ?? 'alice'
    const agentHome = homes[user]
    if (!agentHome) {
      res.writeHead(400)
      res.end()
      return
    }
    const result = runWithRequestScope({ agentHome, cwd: agentHome }, () =>
      router(req, res),
    )
    void Promise.resolve(result)
      .then(handled => {
        if (!handled && !res.headersSent) {
          res.writeHead(404)
          res.end()
        }
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  baseURL = `http://127.0.0.1:${address.port}`
}

async function stopServer(): Promise<void> {
  if (!server) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function jsonRequest(
  pathname: string,
  options: {
    method?: string
    body?: Record<string, unknown>
    user?: string
  } = {},
): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: options.method,
    headers: {
      'x-test-user': options.user ?? 'alice',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const raw = await response.text()
  return {
    status: response.status,
    body: raw ? JSON.parse(raw) : undefined,
    raw,
  }
}

async function upload(
  dir: string,
  bytes: string | Buffer,
  name: string,
  options: { kind?: string; user?: string } = {},
): Promise<{ status: number; body: any; raw: string }> {
  const form = new FormData()
  form.append('dir', dir)
  if (options.kind) form.append('kind', options.kind)
  const payload = typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)
  form.append('file', new Blob([payload]), name)
  const response = await fetch(`${baseURL}/user-config/upload`, {
    method: 'POST',
    headers: { 'x-test-user': options.user ?? 'alice' },
    body: form,
  })
  const raw = await response.text()
  return {
    status: response.status,
    body: raw ? JSON.parse(raw) : undefined,
    raw,
  }
}

async function zipFiles(
  files: Array<{
    name: string
    contents?: string | Buffer
    mode?: number
    symlinkTarget?: string
  }>,
): Promise<Buffer> {
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const done = new Promise<Buffer>((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
  })
  const archive = new ZipArchive()
  archive.on('error', error => output.destroy(error))
  archive.pipe(output)
  for (const file of files) {
    if (file.symlinkTarget) {
      ;(
        archive as Archiver & {
          symlink(name: string, target: string, mode?: number): Archiver
        }
      ).symlink(file.name, file.symlinkTarget, file.mode)
    } else {
      archive.append(file.contents ?? '', {
        name: file.name,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      })
    }
  }
  await archive.finalize()
  return done
}

function replaceZipName(archive: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to))
  const result = Buffer.from(archive)
  const needle = Buffer.from(from)
  const replacement = Buffer.from(to)
  let offset = 0
  let replacements = 0
  while ((offset = result.indexOf(needle, offset)) !== -1) {
    replacement.copy(result, offset)
    offset += replacement.length
    replacements += 1
  }
  expect(replacements).toBeGreaterThanOrEqual(2)
  return result
}

async function makeOwnedSkill(user = 'alice'): Promise<void> {
  const skillDir = path.join(appDir(user), 'skills', 'owned')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: owned\ndescription: Marketplace skill\n---\nOwned.\n',
  )
  await fs.writeFile(
    path.join(appDir(user), 'marketplace-lock.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          providerId: 'test-market',
          externalId: 'owned-skill',
          kind: 'skill',
          name: 'owned',
          path: '.ai-agent/skills/owned',
          installedAt: new Date().toISOString(),
        },
      ],
    }),
  )
}

beforeEach(async () => {
  process.env.AUTH_ENABLED = 'true'
  delete process.env.AI_AGENT_DIR
  const testTmp = fsSync.existsSync('/tmp') ? '/tmp' : os.tmpdir()
  tempRoot = await fs.mkdtemp(path.join(testTmp, 'user-config-api-'))
  homes = {
    alice: path.join(tempRoot, 'alice'),
    bob: path.join(tempRoot, 'bob'),
  }
  await Promise.all(Object.values(homes).map(value => fs.mkdir(value)))
  await startServer()
})

afterEach(async () => {
  await stopServer()
  await fs.rm(tempRoot, { recursive: true, force: true })
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  if (previousAppDir === undefined) delete process.env.AI_AGENT_DIR
  else process.env.AI_AGENT_DIR = previousAppDir
})

describe('user config request scope and CRUD', () => {
  it('keeps two users isolated and returns only relative paths', async () => {
    expect(
      (
        await jsonRequest('/user-config/mkdir', {
          method: 'POST',
          body: { path: 'rules' },
        })
      ).status,
    ).toBe(200)
    const created = await jsonRequest('/user-config/file', {
      method: 'POST',
      body: { path: 'rules/alice.md', content: 'alice only' },
    })
    expect(created.status).toBe(200)
    expect(created.body.path).toBe('rules/alice.md')
    expect(created.raw).not.toContain(home('alice'))

    const bobRead = await jsonRequest(
      '/user-config/file?path=rules%2Falice.md',
      { user: 'bob' },
    )
    expect(bobRead).toMatchObject({
      status: 404,
      body: { code: 'ENOENT' },
    })
    expect(fsSync.existsSync(path.join(appDir('bob'), 'rules/alice.md'))).toBe(
      false,
    )
    expect(
      await fs.readFile(path.join(appDir('alice'), 'rules/alice.md'), 'utf8'),
    ).toBe('alice only')
  })

  it('exposes only the four allowed roots', async () => {
    const metadata = await jsonRequest('/user-config')
    expect(metadata.status).toBe(200)
    expect(metadata.body).toMatchObject({
      root: '',
      displayName: '.ai-agent',
      allowedRoots: ['skills', 'agents', 'rules', 'commands'],
      generation: 0,
    })
    expect(metadata.raw).not.toContain(home())

    for (const root of ['skills', 'agents', 'rules', 'commands']) {
      expect(
        (
          await jsonRequest('/user-config/mkdir', {
            method: 'POST',
            body: { path: `${root}/nested` },
          })
        ).status,
      ).toBe(200)
    }
    for (const disallowed of [
      'settings.json',
      'AGENTS.md',
      'plugins/example.md',
      'sessions/run.json',
      '.marketplace-backups/x',
    ]) {
      const response = await jsonRequest('/user-config/file', {
        method: 'POST',
        body: { path: disallowed, content: 'no' },
      })
      expect(response.status).toBe(403)
      expect(response.body.code).toBe('EROOT')
    }
  })

  it('reports mtime conflicts and leaves no atomic-write staging files', async () => {
    await jsonRequest('/user-config/mkdir', {
      method: 'POST',
      body: { path: 'rules' },
    })
    await jsonRequest('/user-config/file', {
      method: 'POST',
      body: { path: 'rules/conflict.md', content: 'first' },
    })
    const first = await jsonRequest(
      '/user-config/file?path=rules%2Fconflict.md',
    )
    const absolute = path.join(appDir(), 'rules', 'conflict.md')
    await fs.writeFile(absolute, 'external')
    const future = new Date(Date.now() + 10_000)
    await fs.utimes(absolute, future, future)

    const conflict = await jsonRequest('/user-config/file', {
      method: 'PUT',
      body: {
        path: 'rules/conflict.md',
        content: 'stale write',
        mtimeMs: first.body.mtimeMs,
      },
    })
    expect(conflict).toMatchObject({
      status: 409,
      body: { code: 'EMTIME' },
    })
    expect(await fs.readFile(absolute, 'utf8')).toBe('external')

    const current = await jsonRequest(
      '/user-config/file?path=rules%2Fconflict.md',
    )
    const saved = await jsonRequest('/user-config/file', {
      method: 'PUT',
      body: {
        path: 'rules/conflict.md',
        content: 'atomic result',
        mtimeMs: current.body.mtimeMs,
      },
    })
    expect(saved.status).toBe(200)
    expect(await fs.readFile(absolute, 'utf8')).toBe('atomic result')
    expect(
      (await fs.readdir(path.dirname(absolute))).filter(name =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([])
  })

  it('duplicates files and valid Skill directories', async () => {
    await makeOwnedSkill()
    const duplicate = await jsonRequest('/user-config/duplicate', {
      method: 'POST',
      body: { path: 'skills/owned', name: 'owned-copy' },
    })
    expect(duplicate).toMatchObject({
      status: 200,
      body: {
        path: 'skills/owned-copy',
        isDir: true,
        readOnly: false,
      },
    })
    const copied = await fs.readFile(
      path.join(appDir(), 'skills', 'owned-copy', 'SKILL.md'),
      'utf8',
    )
    expect(copied).toMatch(/name: owned-copy/)
    expect(copied).not.toMatch(/^name: owned$/m)

    await jsonRequest('/user-config/mkdir', {
      method: 'POST',
      body: { path: 'agents' },
    })
    await jsonRequest('/user-config/file', {
      method: 'POST',
      body: {
        path: 'agents/reviewer.md',
        content:
          '---\nname: reviewer\ndescription: Review code\n---\nReview it.\n',
      },
    })
    const agentCopy = await jsonRequest('/user-config/duplicate', {
      method: 'POST',
      body: { path: 'agents/reviewer.md' },
    })
    expect(agentCopy.body.path).toBe('agents/reviewer-copy.md')
    expect(
      await fs.readFile(
        path.join(appDir(), 'agents', 'reviewer-copy.md'),
        'utf8',
      ),
    ).toMatch(/name: reviewer-copy/)
  })

  it('keeps requested duplicate names to one path segment', async () => {
    await jsonRequest('/user-config/mkdir', {
      method: 'POST',
      body: { path: 'rules' },
    })
    await jsonRequest('/user-config/file', {
      method: 'POST',
      body: { path: 'rules/source.md', content: 'source' },
    })

    for (const name of [
      '../outside.md',
      'nested/copy.md',
      String.raw`nested\copy.md`,
      '/absolute.md',
      '.',
      '',
      '.user-config-stage-forged',
    ]) {
      const response = await jsonRequest('/user-config/duplicate', {
        method: 'POST',
        body: { path: 'rules/source.md', name },
      })
      expect([400, 403]).toContain(response.status)
      expect(response.body.code).toMatch(/EINVAL|ERESERVED/)
    }
    expect(await fs.readdir(path.join(appDir(), 'rules'))).toEqual([
      'source.md',
    ])
  })

  it('rejects a symlink copied after duplicate preflight', async () => {
    const source = path.join(appDir(), 'skills', 'race-skill')
    const sourceSkill = path.join(source, 'SKILL.md')
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(
      sourceSkill,
      '---\nname: race-skill\ndescription: Race test\n---\nSafe.\n',
    )
    const outside = path.join(tempRoot, 'outside-skill.md')
    const outsideContents =
      '---\nname: outside\ndescription: Outside file\n---\nDo not change.\n'
    await fs.writeFile(outside, outsideContents)

    const originalCp = fs.cp.bind(fs)
    const cpSpy = vi.spyOn(fs, 'cp')
    cpSpy.mockImplementation(
      async (...args: Parameters<typeof fs.cp>): Promise<void> => {
        const [copySource, destination, options] = args
        await fs.rm(path.join(String(copySource), 'SKILL.md'))
        await fs.symlink(outside, path.join(String(copySource), 'SKILL.md'))
        await originalCp(copySource, destination, options)
      },
    )

    try {
      const response = await jsonRequest('/user-config/duplicate', {
        method: 'POST',
        body: { path: 'skills/race-skill' },
      })
      expect(response).toMatchObject({
        status: 403,
        body: { code: 'ESYMLINK' },
      })
    } finally {
      cpSpy.mockRestore()
    }

    expect(await fs.readFile(outside, 'utf8')).toBe(outsideContents)
    expect(
      fsSync.existsSync(path.join(appDir(), 'skills', 'race-skill-copy')),
    ).toBe(false)
    expect(
      (await fs.readdir(path.join(appDir(), 'skills'))).some(name =>
        name.startsWith('.user-config-stage-'),
      ),
    ).toBe(false)
  })
})

describe('user config path safety', () => {
  it.each([
    '/etc/passwd',
    '../outside',
    'skills/../../outside',
    'skills/../outside',
    String.raw`C:\Windows\system.ini`,
    String.raw`skills\..\outside`,
    'skills//outside',
    'skills/\0outside',
  ])('rejects unsafe body path %s', async unsafe => {
    const response = await jsonRequest('/user-config/file', {
      method: 'POST',
      body: { path: unsafe, content: 'blocked' },
    })
    expect([400, 403]).toContain(response.status)
    expect(response.body).toHaveProperty('error')
    expect(response.body).toHaveProperty('code')
  })

  it.each([
    '%2Fetc%2Fpasswd',
    '..%2Foutside',
    'skills%2F%2E%2E%2Foutside',
    'skills%5C..%5Coutside',
    'skills%2F%00outside',
  ])('rejects encoded query traversal %s', async unsafe => {
    const response = await jsonRequest(`/user-config/file?path=${unsafe}`)
    expect([400, 403]).toContain(response.status)
    expect(response.body.code).toMatch(/EABSOLUTE|ETRAVERSAL|EINVAL|ENUL/)
  })

  it('rejects root, intermediate, final, and embedded symlinks', async () => {
    const outside = path.join(tempRoot, 'outside')
    await fs.mkdir(outside)
    const outsideFile = path.join(outside, 'keep.txt')
    await fs.writeFile(outsideFile, 'keep')

    await fs.mkdir(path.join(appDir(), 'skills'), { recursive: true })
    await fs.symlink(outside, path.join(appDir(), 'skills', 'dir-link'))
    await fs.symlink(outsideFile, path.join(appDir(), 'skills', 'file-link'))

    const intermediate = await jsonRequest(
      '/user-config/list?dir=skills%2Fdir-link',
    )
    expect(intermediate).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
    const final = await jsonRequest('/user-config/file?path=skills%2Ffile-link')
    expect(final).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
    const embedded = await jsonRequest('/user-config/entry?path=skills', {
      method: 'DELETE',
    })
    expect(embedded).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('keep')

    await fs.rm(path.join(appDir(), 'skills'), {
      recursive: true,
      force: true,
    })
    await fs.symlink(outside, path.join(appDir(), 'skills'))
    const rootLink = await jsonRequest('/user-config/list?dir=skills')
    expect(rootLink).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })

    await fs.rm(appDir(), { recursive: true, force: true })
    await fs.symlink(outside, appDir())
    const configRootLink = await jsonRequest('/user-config')
    expect(configRootLink).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
  })

  it('rejects special files', async () => {
    await fs.mkdir(path.join(appDir(), 'rules'), { recursive: true })
    const socketPath = path.join(appDir(), 'rules', 'special.sock')
    const socket = net.createServer()
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.listen(socketPath, resolve)
    })
    try {
      const response = await jsonRequest(
        '/user-config/file?path=rules%2Fspecial.sock',
      )
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'ESPECIAL' },
      })
    } finally {
      await new Promise<void>(resolve => socket.close(() => resolve()))
    }
  })

  it('cannot delete a host path through absolute, traversal, or symlink paths', async () => {
    const hostFile = path.join(tempRoot, 'host-must-survive.txt')
    await fs.writeFile(hostFile, 'survive')
    await fs.mkdir(path.join(appDir(), 'commands'), { recursive: true })
    await fs.symlink(tempRoot, path.join(appDir(), 'commands', 'host'))

    for (const candidate of [
      hostFile,
      '../../host-must-survive.txt',
      'commands/host/host-must-survive.txt',
    ]) {
      const response = await jsonRequest(
        `/user-config/entry?path=${encodeURIComponent(candidate)}`,
        { method: 'DELETE' },
      )
      expect([400, 403]).toContain(response.status)
    }
    expect(await fs.readFile(hostFile, 'utf8')).toBe('survive')
  })
})

describe('Marketplace ownership and generation', () => {
  it('fails closed for malformed or symlinked ownership locks', async () => {
    await fs.mkdir(appDir(), { recursive: true })
    const lockPath = path.join(appDir(), 'marketplace-lock.json')
    await fs.writeFile(lockPath, '{not-json')
    const malformed = await jsonRequest('/user-config/mkdir', {
      method: 'POST',
      body: { path: 'rules' },
    })
    expect(malformed).toMatchObject({
      status: 500,
      body: { code: 'EOWNERSHIP' },
    })
    expect(fsSync.existsSync(path.join(appDir(), 'rules'))).toBe(false)

    await fs.rm(lockPath)
    const outsideLock = path.join(tempRoot, 'outside-lock.json')
    await fs.writeFile(outsideLock, '{"version":1,"entries":[]}')
    await fs.symlink(outsideLock, lockPath)
    const symlinked = await jsonRequest('/user-config/list?dir=skills')
    expect(symlinked).toMatchObject({
      status: 403,
      body: { code: 'ESYMLINK' },
    })
    expect(symlinked.raw).not.toContain(outsideLock)
  })

  it('marks installed resources read-only and permits a user copy', async () => {
    await makeOwnedSkill()
    const listed = await jsonRequest('/user-config/list?dir=skills')
    expect(listed.status).toBe(200)
    expect(listed.body.entries).toContainEqual(
      expect.objectContaining({
        path: 'skills/owned',
        readOnly: true,
        ownership: expect.objectContaining({
          source: 'marketplace',
          providerId: 'test-market',
          externalId: 'owned-skill',
        }),
      }),
    )
    const read = await jsonRequest(
      '/user-config/file?path=skills%2Fowned%2FSKILL.md',
    )
    expect(read.body).toMatchObject({
      readOnly: true,
      ownership: { source: 'marketplace' },
    })

    const write = await jsonRequest('/user-config/file', {
      method: 'PUT',
      body: {
        path: 'skills/owned/SKILL.md',
        content: 'blocked',
        mtimeMs: read.body.mtimeMs,
      },
    })
    expect(write).toMatchObject({
      status: 403,
      body: { code: 'EOWNED' },
    })
    const remove = await jsonRequest('/user-config/entry?path=skills%2Fowned', {
      method: 'DELETE',
    })
    expect(remove).toMatchObject({
      status: 403,
      body: { code: 'EOWNED' },
    })

    const copied = await jsonRequest('/user-config/duplicate', {
      method: 'POST',
      body: { path: 'skills/owned', name: 'personal-copy' },
    })
    expect(copied.status).toBe(200)
    expect(copied.body.readOnly).toBe(false)

    const copiedFile = await jsonRequest(
      '/user-config/file?path=skills%2Fpersonal-copy%2FSKILL.md',
    )
    expect(copiedFile.body.readOnly).toBe(false)
    const edited = await jsonRequest('/user-config/file', {
      method: 'PUT',
      body: {
        path: 'skills/personal-copy/SKILL.md',
        content:
          '---\nname: personal-copy\ndescription: Editable copy\n---\nChanged.\n',
        mtimeMs: copiedFile.body.mtimeMs,
      },
    })
    expect(edited.status).toBe(200)
    expect(
      await fs.readFile(
        path.join(appDir(), 'skills', 'personal-copy', 'SKILL.md'),
        'utf8',
      ),
    ).toMatch(/Changed\./)
  })

  it('bumps generation for API and Marketplace mutations', async () => {
    expect(await getUserConfigGeneration(appDir())).toBe(0)
    const mkdir = await jsonRequest('/user-config/mkdir', {
      method: 'POST',
      body: { path: 'commands' },
    })
    expect(mkdir.body.generation).toBe(1)
    const created = await jsonRequest('/user-config/file', {
      method: 'POST',
      body: { path: 'commands/test.md', content: 'test' },
    })
    expect(created.body.generation).toBe(2)

    const config: MarketplaceProviderConfig = {
      id: 'test-market',
      type: 'skills-sh',
      baseURL: 'https://example.test',
    }
    await installMarketplaceArtifact(home(), config, {
      kind: 'skill',
      format: 'files',
      item: {
        providerId: 'test-market',
        externalId: 'generation-skill',
        kind: 'skill',
        name: 'generation-skill',
      },
      files: [
        {
          path: 'SKILL.md',
          contents:
            '---\nname: generation-skill\ndescription: Generation test\n---\nTest.\n',
        },
      ],
    })
    expect(await getUserConfigGeneration(appDir())).toBe(3)
    await uninstallMarketplaceArtifact(
      home(),
      'test-market',
      'skill',
      'generation-skill',
    )
    expect(await getUserConfigGeneration(appDir())).toBe(4)
    expect(
      await fs.readFile(
        path.join(appDir(), USER_CONFIG_GENERATION_FILE),
        'utf8',
      ),
    ).toBe('4\n')
  })
})

describe('user config uploads and downloads', () => {
  it('uploads normal files and a validated Skill ZIP', async () => {
    const normal = await upload('rules', 'rule body', 'rule.md')
    expect(normal).toMatchObject({
      status: 200,
      body: {
        dir: 'rules',
        uploaded: [
          {
            name: 'rule.md',
            path: 'rules/rule.md',
            kind: 'file',
          },
        ],
      },
    })
    expect(normal.raw).not.toContain(home())

    const skillZip = await zipFiles([
      {
        name: 'uploaded-skill/SKILL.md',
        contents:
          '---\nname: uploaded-skill\ndescription: Uploaded skill\n---\nUse it.\n',
      },
      {
        name: 'uploaded-skill/references/readme.md',
        contents: 'reference',
      },
    ])
    const skill = await upload('skills', skillZip, 'uploaded-skill.zip')
    expect(skill).toMatchObject({
      status: 200,
      body: {
        uploaded: [
          {
            name: 'uploaded-skill',
            path: 'skills/uploaded-skill',
            kind: 'skill',
          },
        ],
      },
    })
    expect(
      await fs.readFile(
        path.join(appDir(), 'skills', 'uploaded-skill', 'SKILL.md'),
        'utf8',
      ),
    ).toMatch(/name: uploaded-skill/)
  })

  it('rejects traversal, symlink, missing-manifest, and oversized ZIPs', async () => {
    const unsafeFilename = await upload('rules', 'blocked', '../escape.md')
    expect(unsafeFilename).toMatchObject({
      status: 400,
      body: { code: 'EINVAL' },
    })
    expect(fsSync.existsSync(path.join(tempRoot, 'escape.md'))).toBe(false)

    const oversizedFile = await upload(
      'rules',
      Buffer.alloc(5 * 1024 * 1024 + 1),
      'large.bin',
    )
    expect(oversizedFile).toMatchObject({
      status: 413,
      body: { code: 'E2BIG' },
    })

    const safeTraversalZip = await zipFiles([
      { name: 'xx/evil.txt', contents: 'escape' },
      {
        name: 'zip-skill/SKILL.md',
        contents: '---\nname: zip-skill\ndescription: Zip test\n---\nTest.\n',
      },
    ])
    const traversalZip = replaceZipName(
      safeTraversalZip,
      'xx/evil.txt',
      '../evil.txt',
    )
    const traversal = await upload('skills', traversalZip, 'traversal.zip')
    expect(traversal.status).toBe(400)
    expect(traversal.body.code).toBe('EZIP')
    expect(fsSync.existsSync(path.join(tempRoot, 'evil.txt'))).toBe(false)

    const symlinkZip = await zipFiles([
      {
        name: 'link-skill/SKILL.md',
        contents: '---\nname: link-skill\ndescription: Link test\n---\nTest.\n',
      },
      {
        name: 'link-skill/link',
        symlinkTarget: '../outside',
        mode: 0o777,
      },
    ])
    const symlink = await upload('skills', symlinkZip, 'symlink.zip')
    expect(symlink.status).toBe(400)
    expect(symlink.body.code).toBe('EZIP')

    const missing = await upload(
      'skills',
      await zipFiles([{ name: 'readme.md', contents: 'no manifest' }]),
      'missing.zip',
    )
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('EZIP')

    const oversized = await upload(
      'skills',
      Buffer.alloc(SKILL_PACKAGE_LIMITS.maxDownloadBytes + 1),
      'oversized.zip',
    )
    expect(oversized).toMatchObject({
      status: 413,
      body: { code: 'E2BIG' },
    })

    const expanded = await zipFiles([
      {
        name: 'expanded-skill/SKILL.md',
        contents:
          '---\nname: expanded-skill\ndescription: Expanded test\n---\nTest.\n',
      },
      {
        name: 'expanded-skill/large.txt',
        contents: Buffer.alloc(SKILL_PACKAGE_LIMITS.maxExtractBytes + 1, 0x61),
      },
    ])
    const expandedResult = await upload('skills', expanded, 'expanded.zip')
    expect(expandedResult).toMatchObject({
      status: 413,
      body: { code: 'E2BIG' },
    })
  }, 30_000)

  it('downloads files without exposing host paths', async () => {
    await upload('commands', 'download me', 'download.md')
    const response = await fetch(
      `${baseURL}/user-config/download?path=commands%2Fdownload.md`,
      { headers: { 'x-test-user': 'alice' } },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('download.md')
    expect(await response.text()).toBe('download me')
    expect(response.headers.get('content-disposition')).not.toContain(home())
  })
})
