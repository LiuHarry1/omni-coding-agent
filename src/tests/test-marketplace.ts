import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import * as archiverModule from 'archiver'
import type { Archiver } from 'archiver'
import {
  decorateInstallState,
  installMarketplaceArtifact,
  previewMarketplaceBundle,
  readMarketplaceLock,
  uninstallMarketplaceArtifact,
} from '../server/marketplace/installer.js'
import { SkillsShProvider } from '../server/marketplace/skills-sh-provider.js'
import { DemeterProvider } from '../server/marketplace/demeter-provider.js'
import { loadSkillsFromDisk } from '../skills/loadSkillsDir.js'
import type { MarketplaceItem } from '../server/marketplace/types.js'
import type { MarketplaceProviderConfig } from '../core/types.js'
import {
  resetSettingsCache,
  resolveSettings,
} from '../utils/settings/manager.js'
import { runWithRequestScope } from '../utils/workspace/request-scope.js'

const ZipArchive = (
  archiverModule as unknown as { ZipArchive: new () => Archiver }
).ZipArchive

const config: MarketplaceProviderConfig = {
  id: 'test',
  type: 'skills-sh',
  baseURL: 'https://example.test/api',
  auth: 'none',
  capabilities: ['skills'],
  maxFiles: 20,
  maxExtractBytes: 100_000,
}

function skillArtifact(
  id: string,
  name: string,
  version: string,
  body = 'Use this skill.',
) {
  const item: MarketplaceItem = {
    providerId: 'test',
    externalId: id,
    kind: 'skill',
    name,
    version,
  }
  return {
    kind: 'skill' as const,
    format: 'files' as const,
    item,
    files: [
      {
        path: 'SKILL.md',
        contents: `---\nname: ${name}\ndescription: Test ${name}\n---\n${body}\n`,
      },
      { path: 'references/readme.md', contents: 'reference' },
    ],
  }
}

async function zipFiles(files: Record<string, string>): Promise<Buffer> {
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const done = new Promise<Buffer>((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
  })
  const archive = new ZipArchive()
  archive.on('error', (error: Error) => output.destroy(error))
  archive.pipe(output)
  for (const [name, contents] of Object.entries(files)) {
    archive.append(contents, { name })
  }
  await archive.finalize()
  return done
}

async function testInstaller(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-test-'))
  try {
    const first = skillArtifact(
      'owner/repo/portable-skill',
      'portable-skill',
      '1',
    )
    await installMarketplaceArtifact(cwd, config, first)
    const skillPath = path.join(
      cwd,
      '.ai-agent',
      'skills',
      'portable-skill',
      'SKILL.md',
    )
    assert.match(await fs.readFile(skillPath, 'utf8'), /Use this skill/)

    const discovered = await loadSkillsFromDisk(cwd)
    assert.ok(
      discovered.skills.some(skill => skill.name === 'portable-skill'),
      '.ai-agent/skills should be discovered',
    )

    const previousAuthEnabled = process.env.AUTH_ENABLED
    process.env.AUTH_ENABLED = 'true'
    try {
      const ssoDiscovered = await runWithRequestScope(
        { agentHome: cwd, cwd },
        () => loadSkillsFromDisk(cwd),
      )
      assert.ok(
        ssoDiscovered.skills.some(skill => skill.name === 'portable-skill'),
        'SSO home should discover user .ai-agent/skills',
      )
    } finally {
      if (previousAuthEnabled === undefined) delete process.env.AUTH_ENABLED
      else process.env.AUTH_ENABLED = previousAuthEnabled
    }

    const lock = await readMarketplaceLock(cwd)
    assert.equal(lock.entries.length, 1)
    assert.equal(
      decorateInstallState(first.item, lock, {
        skills: new Set(['portable-skill']),
        agents: new Set(),
      }).installState,
      'installed',
    )

    const updated = skillArtifact(
      'owner/repo/portable-skill',
      'portable-skill',
      '2',
      'Updated instructions.',
    )
    assert.equal(
      decorateInstallState(updated.item, lock, {
        skills: new Set(['portable-skill']),
        agents: new Set(),
      }).installState,
      'updateAvailable',
    )

    // Migrate an item installed by the earlier `.agents/skills` behavior.
    const legacySkillDir = path.join(cwd, '.agents', 'skills', 'portable-skill')
    await fs.mkdir(path.dirname(legacySkillDir), { recursive: true })
    await fs.rename(path.dirname(skillPath), legacySkillDir)
    const lockFile = path.join(cwd, '.ai-agent', 'marketplace-lock.json')
    const legacyLock = JSON.parse(await fs.readFile(lockFile, 'utf8'))
    legacyLock.entries[0].path = path.relative(cwd, legacySkillDir)
    await fs.writeFile(lockFile, `${JSON.stringify(legacyLock, null, 2)}\n`)

    await installMarketplaceArtifact(cwd, config, updated)
    assert.match(await fs.readFile(skillPath, 'utf8'), /Updated instructions/)
    await assert.rejects(fs.access(legacySkillDir), /ENOENT/)

    await uninstallMarketplaceArtifact(
      cwd,
      config.id,
      'skill',
      updated.item.externalId,
    )
    await assert.rejects(fs.access(skillPath), /ENOENT/)
    assert.equal((await readMarketplaceLock(cwd)).entries.length, 0)

    await installMarketplaceArtifact(cwd, config, updated)
    await fs.rm(path.dirname(skillPath), { recursive: true })
    assert.equal(
      (await readMarketplaceLock(cwd)).entries.length,
      0,
      'manual deletion should prune stale marketplace lock entries',
    )

    await assert.rejects(
      installMarketplaceArtifact(cwd, config, {
        ...skillArtifact('unsafe', 'unsafe-skill', '1'),
        files: [
          {
            path: '../SKILL.md',
            contents:
              '---\nname: unsafe-skill\ndescription: Unsafe\n---\nNo.\n',
          },
        ],
      }),
      /Unsafe marketplace artifact path/,
    )

    const manualPath = path.join(cwd, '.ai-agent', 'skills', 'manual-skill')
    await fs.mkdir(manualPath, { recursive: true })
    await fs.writeFile(
      path.join(manualPath, 'SKILL.md'),
      '---\nname: manual-skill\ndescription: Manual\n---\nManual.\n',
    )
    await assert.rejects(
      installMarketplaceArtifact(
        cwd,
        config,
        skillArtifact('other/manual', 'manual-skill', '1'),
      ),
      /not managed by this item/,
    )

    const agentConfig: MarketplaceProviderConfig = {
      ...config,
      id: 'demeter',
      type: 'demeter',
      capabilities: ['skills', 'agents'],
    }
    await installMarketplaceArtifact(cwd, agentConfig, {
      kind: 'agent',
      format: 'markdown',
      item: {
        providerId: 'demeter',
        externalId: 'agent-1',
        kind: 'agent',
        name: 'reviewer',
        version: '1',
      },
      contents:
        '---\nname: reviewer\ndescription: Reviews code changes\n---\nReview carefully.\n',
    })
    assert.match(
      await fs.readFile(
        path.join(cwd, '.ai-agent', 'agents', 'reviewer.md'),
        'utf8',
      ),
      /Review carefully/,
    )
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

async function testBundleInstaller(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-test-'))
  const bundleConfig: MarketplaceProviderConfig = {
    ...config,
    id: 'demeter',
    type: 'demeter',
    capabilities: ['bundles'],
  }
  try {
    const item: MarketplaceItem = {
      providerId: 'demeter',
      externalId: 'bundle-1',
      kind: 'bundle',
      name: 'Copilot Starter',
      version: '1.0.0',
      platformType: 'copilot',
    }
    const artifact = {
      kind: 'bundle' as const,
      format: 'zip' as const,
      item,
      bytes: await zipFiles({
        '.github/agents/reviewer.agent.md':
          '---\nname: reviewer\ndescription: Reviews changes\n---\nReview carefully.',
        '.github/copilot-instructions.md': 'Team instructions.',
        '.github/instructions/typescript.instructions.md':
          '---\napplyTo: "**/*.ts"\n---\nUse TypeScript.',
        '.github/skills/demo/SKILL.md':
          '---\nname: demo\ndescription: Demo skill\n---\nDemo.',
        '.github/skills/shared/helpers.py': 'print("shared")',
        '.github/config/team.json': '{}',
      }),
    }

    await fs.mkdir(path.join(cwd, '.ai-agent'), { recursive: true })
    await fs.writeFile(
      path.join(cwd, '.ai-agent', 'AGENTS.md'),
      'Existing instructions.',
    )
    const preview = await previewMarketplaceBundle(cwd, bundleConfig, artifact)
    assert.equal(preview.canInstall, true)
    assert.equal(preview.requiresConfirmation, true)
    assert.equal(preview.files.length, 6)
    assert.equal(
      preview.files.find(file => file.sourcePath.includes('reviewer'))
        ?.targetPath,
      '.ai-agent/agents/reviewer.md',
    )
    assert.equal(
      preview.files.find(file => file.sourcePath.includes('team.json'))?.state,
      'archiveOnly',
    )

    await assert.rejects(
      installMarketplaceArtifact(cwd, bundleConfig, artifact),
      /conflicts with workspace files/,
    )
    await installMarketplaceArtifact(cwd, bundleConfig, artifact, {
      confirmBundleConflicts: true,
    })
    assert.equal(
      await fs.readFile(
        path.join(cwd, '.ai-agent', 'agents', 'reviewer.md'),
        'utf8',
      ),
      '---\nname: reviewer\ndescription: Reviews changes\n---\nReview carefully.',
    )
    assert.equal(
      await fs.readFile(path.join(cwd, '.ai-agent', 'AGENTS.md'), 'utf8'),
      'Team instructions.',
    )
    assert.equal(
      await fs.readFile(
        path.join(cwd, '.ai-agent', 'skills', 'demo', 'SKILL.md'),
        'utf8',
      ),
      '---\nname: demo\ndescription: Demo skill\n---\nDemo.',
    )
    assert.equal(
      await fs.readFile(
        path.join(cwd, '.ai-agent', 'skills', 'shared', 'helpers.py'),
        'utf8',
      ),
      'print("shared")',
    )
    assert.match(
      await fs.readFile(
        path.join(cwd, '.ai-agent', 'rules', 'typescript.md'),
        'utf8',
      ),
      /paths: '\*\*\/\*\.ts'|paths: "\*\*\/\*\.ts"/,
    )
    await assert.rejects(
      fs.access(path.join(cwd, '.github', 'config', 'team.json')),
      /ENOENT/,
    )
    const lock = await readMarketplaceLock(cwd)
    assert.equal(lock.entries[0]?.kind, 'bundle')
    assert.equal(lock.entries[0]?.files?.length, 5)
    assert.ok(
      lock.entries[0]?.files?.some(file => file.backupPath),
      'confirmed conflicts should be backed up',
    )

    await fs.writeFile(
      path.join(cwd, '.ai-agent', 'agents', 'reviewer.md'),
      'Locally changed',
    )
    const changedPreview = await previewMarketplaceBundle(
      cwd,
      bundleConfig,
      artifact,
    )
    assert.equal(changedPreview.canInstall, true)
    assert.equal(changedPreview.requiresConfirmation, true)
    assert.equal(
      changedPreview.files.find(file => file.sourcePath.includes('reviewer'))
        ?.state,
      'modified',
    )

    await uninstallMarketplaceArtifact(cwd, 'demeter', 'bundle', 'bundle-1')
    assert.equal(
      await fs.readFile(
        path.join(cwd, '.ai-agent', 'agents', 'reviewer.md'),
        'utf8',
      ),
      'Locally changed',
      'uninstall must preserve locally modified files',
    )
    assert.equal(
      await fs.readFile(path.join(cwd, '.ai-agent', 'AGENTS.md'), 'utf8'),
      'Existing instructions.',
      'uninstall should restore the file replaced after confirmation',
    )
    await assert.rejects(
      fs.access(path.join(cwd, '.ai-agent', 'bundles', 'copilot-starter')),
      /ENOENT/,
    )
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

async function testMarketplaceSettingsTrust(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-settings-'))
  const previousAuth = process.env.AUTH_ENABLED
  try {
    const settingsDir = path.join(cwd, '.ai-agent')
    await fs.mkdir(settingsDir, { recursive: true })
    await fs.writeFile(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        marketplaces: {
          providers: [
            {
              id: 'local-market',
              type: 'demeter',
              baseURL: 'http://market.internal/api/v1',
              allowInsecureHttp: true,
            },
          ],
        },
      }),
    )

    delete process.env.AUTH_ENABLED
    resetSettingsCache()
    assert.equal(
      resolveSettings(cwd).config.marketplaces?.providers[0]?.id,
      'local-market',
      'local single-user mode should accept project marketplace settings',
    )

    process.env.AUTH_ENABLED = 'true'
    resetSettingsCache()
    const authenticatedSettings = runWithRequestScope(
      { agentHome: cwd, cwd },
      () => resolveSettings(cwd),
    )
    assert.equal(
      authenticatedSettings.config.marketplaces?.providers.length,
      0,
      'authenticated deployments should ignore non-managed marketplace URLs',
    )
  } finally {
    if (previousAuth === undefined) delete process.env.AUTH_ENABLED
    else process.env.AUTH_ENABLED = previousAuth
    resetSettingsCache()
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

async function testSkillsShAdapter(): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/search')) {
      return new Response(
        JSON.stringify({
          skills: [
            {
              id: 'owner/repo/demo-skill',
              skillId: 'demo-skill',
              name: 'Demo Skill',
              source: 'owner/repo',
              installs: 42,
            },
          ],
          count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        id: 'owner/repo/demo-skill',
        slug: 'demo-skill',
        hash: 'abc',
        files: [
          {
            path: 'SKILL.md',
            contents: '---\nname: demo-skill\ndescription: Demo\n---\nDemo.\n',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const provider = new SkillsShProvider(config)
    const ctx = { identityKey: 'test' }
    const page = await provider.list(ctx, {
      kind: 'skill',
      q: 'demo',
      page: 1,
      perPage: 20,
    })
    assert.equal(page.items[0]?.name, 'demo-skill')
    assert.equal(page.items[0]?.downloads, 42)
    const artifact = await provider.artifact(
      ctx,
      'skill',
      'owner/repo/demo-skill',
    )
    assert.equal(artifact.format, 'files')
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testDemeterAdapter(): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ data: { accessExpiresIn: 3600 } }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'market_access=test-token; Path=/; HttpOnly',
        },
      })
    }
    const headers = new Headers(init?.headers)
    assert.match(headers.get('cookie') ?? '', /market_access=test-token/)
    if (url.includes('/agent-skills?')) {
      return new Response(
        JSON.stringify({
          data: {
            data: [
              {
                id: 'skill-1',
                name: 'demeter-skill',
                description: 'Internal skill',
                version: '3',
                downloadCount: 9,
              },
            ],
            meta: { total: 1 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.endsWith('/agent-skills/skill-1')) {
      return new Response(
        JSON.stringify({
          data: {
            id: 'skill-1',
            name: 'demeter-skill',
            version: '3',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.endsWith('/agent-skills/skill-1/download')) {
      return new Response(Buffer.from('zip bytes'), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      })
    }
    if (url.includes('/ai-contexts?')) {
      return new Response(
        JSON.stringify({
          data: {
            data: [
              {
                id: 'bundle-1',
                name: 'cursor-starter',
                version: '1.0.0',
                platformType: 'cursor',
                anchorHits: [
                  {
                    platform: 'cursor',
                    anchor: 'rules',
                    path: '.cursor/rules',
                  },
                ],
                warnings: [],
              },
            ],
            meta: { total: 1 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.endsWith('/ai-contexts/bundle-1')) {
      return new Response(
        JSON.stringify({
          data: {
            id: 'bundle-1',
            name: 'cursor-starter',
            version: '1.0.0',
            platformType: 'cursor',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.endsWith('/ai-contexts/bundle-1/download')) {
      return new Response(Buffer.from('bundle zip bytes'), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      })
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const provider = new DemeterProvider({
      id: 'demeter',
      type: 'demeter',
      baseURL: 'https://demeter.example/api/v1',
      auth: 'cookie-proxy',
      capabilities: ['skills', 'agents', 'bundles'],
    })
    const ctx = { identityKey: 'tester' }
    await provider.login(ctx, { username: 'user', password: 'password' })
    const page = await provider.list(ctx, {
      kind: 'skill',
      page: 1,
      perPage: 20,
    })
    assert.equal(page.items[0]?.name, 'demeter-skill')
    assert.equal(page.total, 1)
    const artifact = await provider.artifact(ctx, 'skill', 'skill-1')
    assert.equal(artifact.format, 'zip')
    const bundles = await provider.list(ctx, {
      kind: 'bundle',
      page: 1,
      perPage: 20,
    })
    assert.equal(bundles.items[0]?.platformType, 'cursor')
    assert.equal(bundles.items[0]?.anchorHits?.[0]?.anchor, 'rules')
    const bundle = await provider.artifact(ctx, 'bundle', 'bundle-1')
    assert.equal(bundle.kind, 'bundle')
    assert.equal(bundle.format, 'zip')
  } finally {
    globalThis.fetch = originalFetch
  }
}

await testInstaller()
await testBundleInstaller()
await testMarketplaceSettingsTrust()
await testSkillsShAdapter()
await testDemeterAdapter()
console.log('marketplace tests passed')
