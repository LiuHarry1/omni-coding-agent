import { execFileSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellFsPort } from '../../execution/shell-fs.js'
import { expandSkillBody } from '../../skills/expand.js'
import type { SkillDefinition } from '../../skills/types.js'
import {
  materializeCloudSkills,
  resetCloudSkillMaterializationCacheForTesting,
  type CloudSkillMaterializationPort,
} from './skill-materializer.js'
import { USER_CONFIG_GENERATION_FILE } from '../user-config-generation.js'

let tmp: string

beforeEach(() => {
  resetCloudSkillMaterializationCacheForTesting()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-skill-materializer-'))
})

afterEach(() => {
  resetCloudSkillMaterializationCacheForTesting()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function skill(name: string, baseDir: string): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    source: 'user',
    filePath: path.join(baseDir, 'SKILL.md'),
    baseDir,
    context: 'inline',
    argumentNames: [],
    loadBody: async () => 'body',
  }
}

function localPort(): ShellFsPort {
  return new ShellFsPort({
    spawn: script => spawn('sh', ['-c', script]),
  })
}

function options(
  skills: SkillDefinition[],
  port: CloudSkillMaterializationPort = localPort(),
) {
  return {
    workspaceId: 'abcdef0123456789',
    skills,
    port,
    sessionRoot: path.join(tmp, 'container-tmp'),
  }
}

function setGeneration(root: string, generation: number): void {
  write(path.join(root, USER_CONFIG_GENERATION_FILE), `${generation}\n`)
}

function countingPort(): {
  port: CloudSkillMaterializationPort
  writes: () => number
} {
  const base = localPort()
  let writeCount = 0
  return {
    port: {
      run: base.run.bind(base),
      mkdir: base.mkdir.bind(base),
      remove: base.remove.bind(base),
      writeFile: async (filePath, data, writeOptions) => {
        writeCount++
        return base.writeFile(filePath, data, writeOptions)
      },
    },
    writes: () => writeCount,
  }
}

describe('cloud skill materializer', () => {
  it('copies complete packages, preserves executable bits, and maps runtime paths', async () => {
    const packageDir = path.join(tmp, 'host/skills/demo')
    write(path.join(packageDir, 'SKILL.md'), '# Demo')
    write(path.join(packageDir, 'references/guide.md'), 'guide')
    write(path.join(packageDir, 'assets/data.bin'), Buffer.from([0, 1, 2, 3]))
    write(path.join(packageDir, 'scripts/run.sh'), '#!/bin/sh\necho ok\n')
    fs.chmodSync(path.join(packageDir, 'scripts/run.sh'), 0o755)

    const result = await materializeCloudSkills(
      options([skill('demo', packageDir)]),
    )

    expect(result.copied).toBe(true)
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    const runtimeDir = result.skills[0]!.runtimeBaseDir!
    expect(runtimeDir).toBe(
      path.posix.join(result.snapshotRoot!, 'skills', 'demo'),
    )
    expect(fs.readFileSync(path.join(runtimeDir, 'SKILL.md'), 'utf8')).toBe(
      '# Demo',
    )
    expect(
      fs.readFileSync(path.join(runtimeDir, 'references/guide.md'), 'utf8'),
    ).toBe('guide')
    expect(fs.readFileSync(path.join(runtimeDir, 'assets/data.bin'))).toEqual(
      Buffer.from([0, 1, 2, 3]),
    )
    expect(
      fs.statSync(path.join(runtimeDir, 'scripts/run.sh')).mode & 0o111,
    ).toBe(0o111)

    const mapped = result.skills[0]!
    mapped.loadBody = async () => 'Run ${SKILL_DIR}/scripts/run.sh'
    const expanded = await expandSkillBody(mapped, '', '/workspace/repo')
    expect(mapped.baseDir).toBe(packageDir)
    expect(expanded.combined).toContain(
      `Base directory for this skill: ${runtimeDir}`,
    )
    expect(expanded.combined).toContain(`${runtimeDir}/scripts/run.sh`)
    expect(expanded.combined).not.toContain(packageDir)
  })

  it('reuses an unchanged hash and publishes a new hash after content changes', async () => {
    const packageDir = path.join(tmp, 'host/skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    const port = localPort()

    const first = await materializeCloudSkills(
      options([skill('demo', packageDir)], port),
    )
    const second = await materializeCloudSkills(
      options([skill('demo', packageDir)], port),
    )
    expect(second.manifestHash).toBe(first.manifestHash)
    expect(second.snapshotRoot).toBe(first.snapshotRoot)
    expect(second.copied).toBe(false)

    write(path.join(packageDir, 'SKILL.md'), 'v2')
    const changed = await materializeCloudSkills(
      options([skill('demo', packageDir)], port),
    )
    expect(changed.manifestHash).not.toBe(first.manifestHash)
    expect(changed.copied).toBe(true)
    expect(
      fs.readFileSync(
        path.join(changed.skills[0]!.runtimeBaseDir!, 'SKILL.md'),
        'utf8',
      ),
    ).toBe('v2')
  })

  it('skips package reads and copies when generation and identities match', async () => {
    const configRoot = path.join(tmp, 'home/.ai-agent')
    const packageDir = path.join(configRoot, 'skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    setGeneration(configRoot, 1)
    const counted = countingPort()
    const input = {
      ...options([skill('demo', packageDir)], counted.port),
      sourceRoot: configRoot,
    }

    const first = await materializeCloudSkills(input)
    const writesAfterFirst = counted.writes()
    fs.renameSync(packageDir, `${packageDir}.moved`)

    const reused = await materializeCloudSkills(input)
    expect(reused.manifestHash).toBe(first.manifestHash)
    expect(reused.snapshotRoot).toBe(first.snapshotRoot)
    expect(reused.copied).toBe(false)
    expect(counted.writes()).toBe(writesAfterFirst)
  })

  it('rescans and rebuilds after the user config generation changes', async () => {
    const configRoot = path.join(tmp, 'home/.ai-agent')
    const packageDir = path.join(configRoot, 'skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    setGeneration(configRoot, 1)
    const counted = countingPort()
    const input = {
      ...options([skill('demo', packageDir)], counted.port),
      sourceRoot: configRoot,
    }

    const first = await materializeCloudSkills(input)
    const writesAfterFirst = counted.writes()
    write(path.join(packageDir, 'SKILL.md'), 'v2')
    setGeneration(configRoot, 2)

    const rebuilt = await materializeCloudSkills(input)
    expect(rebuilt.manifestHash).not.toBe(first.manifestHash)
    expect(rebuilt.copied).toBe(true)
    expect(counted.writes()).toBeGreaterThan(writesAfterFirst)
    expect(
      fs.readFileSync(
        path.join(rebuilt.skills[0]!.runtimeBaseDir!, 'SKILL.md'),
        'utf8',
      ),
    ).toBe('v2')
  })

  it('rescans and uploads when the cached container marker is missing', async () => {
    const configRoot = path.join(tmp, 'home/.ai-agent')
    const packageDir = path.join(configRoot, 'skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    setGeneration(configRoot, 1)
    const counted = countingPort()
    const input = {
      ...options([skill('demo', packageDir)], counted.port),
      sourceRoot: configRoot,
    }

    const first = await materializeCloudSkills(input)
    const writesAfterFirst = counted.writes()
    fs.rmSync(first.snapshotRoot!, { recursive: true, force: true })

    const rebuilt = await materializeCloudSkills(input)
    expect(rebuilt.manifestHash).toBe(first.manifestHash)
    expect(rebuilt.copied).toBe(true)
    expect(counted.writes()).toBeGreaterThan(writesAfterFirst)
    expect(
      fs.readFileSync(path.join(rebuilt.snapshotRoot!, '.complete'), 'utf8'),
    ).toBe(rebuilt.manifestHash)
  })

  it('deduplicates concurrent materialization for one generation', async () => {
    const configRoot = path.join(tmp, 'home/.ai-agent')
    const packageDir = path.join(configRoot, 'skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    setGeneration(configRoot, 1)
    const counted = countingPort()
    const input = {
      ...options([skill('demo', packageDir)], counted.port),
      sourceRoot: configRoot,
    }

    const [first, second] = await Promise.all([
      materializeCloudSkills(input),
      materializeCloudSkills(input),
    ])
    expect(first.manifestHash).toBe(second.manifestHash)
    expect([first.copied, second.copied].sort()).toEqual([false, true])
    expect(counted.writes()).toBe(2)
  })

  it('does not replace known-good metadata after a generation fails', async () => {
    const configRoot = path.join(tmp, 'home/.ai-agent')
    const packageDir = path.join(configRoot, 'skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    setGeneration(configRoot, 1)
    const counted = countingPort()
    const input = {
      ...options([skill('demo', packageDir)], counted.port),
      sourceRoot: configRoot,
    }
    const first = await materializeCloudSkills(input)
    const writesAfterFirst = counted.writes()

    fs.symlinkSync(
      path.join(packageDir, 'SKILL.md'),
      path.join(packageDir, 'invalid-link'),
    )
    setGeneration(configRoot, 2)
    await expect(materializeCloudSkills(input)).rejects.toThrow(
      /Symlink rejected/,
    )

    // Roll back only the test counter to prove the older successful entry was
    // not overwritten by the failed generation.
    setGeneration(configRoot, 1)
    const reused = await materializeCloudSkills(input)
    expect(reused.manifestHash).toBe(first.manifestHash)
    expect(reused.copied).toBe(false)
    expect(counted.writes()).toBe(writesAfterFirst)
  })

  it('rejects symlinks, special files, and configured size limits', async () => {
    const packageDir = path.join(tmp, 'host/skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'demo')
    fs.symlinkSync(
      path.join(packageDir, 'SKILL.md'),
      path.join(packageDir, 'leak.md'),
    )
    await expect(
      materializeCloudSkills(options([skill('demo', packageDir)])),
    ).rejects.toThrow(/Symlink rejected/)

    fs.unlinkSync(path.join(packageDir, 'leak.md'))
    const fifo = path.join(packageDir, 'pipe')
    execFileSync('mkfifo', [fifo])
    await expect(
      materializeCloudSkills(options([skill('demo', packageDir)])),
    ).rejects.toThrow(/Special file rejected/)

    fs.unlinkSync(fifo)
    const oversized = await materializeCloudSkills({
      ...options([skill('demo', packageDir)]),
      limits: { maxSingleFileBytes: 2 },
    })
    expect(oversized.skills).toEqual([])
    expect(oversized.skipped).toEqual([
      expect.objectContaining({
        name: 'demo',
        error: expect.stringMatching(/exceeds 2 bytes/),
      }),
    ])
  })

  it('skips one oversized existing package without blocking valid skills', async () => {
    const validDir = path.join(tmp, 'host/skills/valid')
    const largeDir = path.join(tmp, 'host/skills/large')
    write(path.join(validDir, 'SKILL.md'), 'ok')
    write(path.join(largeDir, 'SKILL.md'), 'too large')

    const result = await materializeCloudSkills({
      ...options([skill('valid', validDir), skill('large', largeDir)]),
      limits: { maxSingleFileBytes: 4 },
    })

    expect(result.skills.map(item => item.name)).toEqual(['valid'])
    expect(result.skills[0]?.runtimeBaseDir).toBeTruthy()
    expect(result.skipped).toEqual([expect.objectContaining({ name: 'large' })])
  })

  it('rejects packages outside the configured host source root', async () => {
    const allowed = path.join(tmp, 'allowed/.ai-agent')
    const outside = path.join(tmp, 'outside/demo')
    fs.mkdirSync(allowed, { recursive: true })
    write(path.join(outside, 'SKILL.md'), 'demo')

    await expect(
      materializeCloudSkills({
        ...options([skill('demo', outside)]),
        sourceRoot: allowed,
      }),
    ).rejects.toThrow(/escapes the allowed source root/)

    const realPackage = path.join(allowed, 'real/demo')
    write(path.join(realPackage, 'SKILL.md'), 'demo')
    fs.symlinkSync(path.join(allowed, 'real'), path.join(allowed, 'linked'))
    await expect(
      materializeCloudSkills({
        ...options([skill('demo', path.join(allowed, 'linked/demo'))]),
        sourceRoot: allowed,
      }),
    ).rejects.toThrow(/Symlink rejected in skill package path/)
  })

  it('keeps the previous snapshot and removes staging after a failed copy', async () => {
    const packageDir = path.join(tmp, 'host/skills/demo')
    write(path.join(packageDir, 'SKILL.md'), 'v1')
    const basePort = localPort()
    const first = await materializeCloudSkills(
      options([skill('demo', packageDir)], basePort),
    )

    write(path.join(packageDir, 'SKILL.md'), 'v2')
    write(path.join(packageDir, 'references/fail.txt'), 'fail')
    const failingPort: CloudSkillMaterializationPort = {
      run: basePort.run.bind(basePort),
      mkdir: basePort.mkdir.bind(basePort),
      remove: basePort.remove.bind(basePort),
      writeFile: async (filePath, data, writeOptions) => {
        if (filePath.endsWith('/references/fail.txt')) {
          throw new Error('injected transfer failure')
        }
        return basePort.writeFile(filePath, data, writeOptions)
      },
    }

    await expect(
      materializeCloudSkills(options([skill('demo', packageDir)], failingPort)),
    ).rejects.toThrow(/injected transfer failure/)

    expect(fs.readdirSync(path.join(tmp, 'container-tmp')).sort()).toEqual([
      first.manifestHash,
    ])
    expect(
      fs.readFileSync(
        path.join(first.skills[0]!.runtimeBaseDir!, 'SKILL.md'),
        'utf8',
      ),
    ).toBe('v1')
  })
})
