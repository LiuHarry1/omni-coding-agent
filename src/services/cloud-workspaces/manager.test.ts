import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCloudWorkspaceConfig } from '../../execution/providers/cloud/config.js'
import { WorkspaceContainers } from '../../execution/providers/cloud/containers.js'
import type { DockerRunner } from '../../execution/providers/cloud/docker-cli.js'
import { EnvironmentRegistry } from '../../execution/environment-registry.js'
import {
  CloudWorkspaceError,
  CloudWorkspaceManager,
  validateRef,
  validateRepoUrl,
} from './manager.js'
import { gitCloneAuthConfig, gitTokenBasicValue } from './repo-access.js'
import type { RepoAccess } from './repo-access.js'
import { CloudWorkspaceStore } from './store.js'
import { isScheduledWorkspaceAvailable } from '../cron/fire.js'

type FakeDocker = {
  run: DockerRunner
  calls: string[][]
  containers: Map<string, boolean>
  failExec?: (args: string[]) => string | null
}

function fakeDocker(): FakeDocker {
  const fake: FakeDocker = {
    calls: [],
    containers: new Map(),
    run: async args => {
      fake.calls.push(args)
      const [cmd, sub] = args
      if (cmd === 'container' && sub === 'inspect') {
        const name = args[args.length - 1]!
        if (!fake.containers.has(name)) {
          return {
            stdout: '',
            stderr: `Error: No such container: ${name}`,
            code: 1,
          }
        }
        return { stdout: `${fake.containers.get(name)}\n`, stderr: '', code: 0 }
      }
      if (cmd === 'run') {
        fake.containers.set(args[args.indexOf('--name') + 1]!, true)
        return { stdout: 'cid\n', stderr: '', code: 0 }
      }
      if (cmd === 'rm') {
        fake.containers.delete(args[args.length - 1]!)
        return { stdout: '', stderr: '', code: 0 }
      }
      if (cmd === 'ps') {
        const ids = [...fake.containers.entries()]
          .filter(([, running]) => running)
          .map(([name]) => name.replace(/^agent-ws-/, ''))
        return { stdout: ids.join('\n'), stderr: '', code: 0 }
      }
      if (cmd === 'exec') {
        const error = fake.failExec?.(args)
        if (error) return { stdout: '', stderr: error, code: 128 }
      }
      return { stdout: '', stderr: '', code: 0 }
    },
  }
  return fake
}

let dir: string
let docker: FakeDocker
let now: number
let manager: CloudWorkspaceManager

function build(env: NodeJS.ProcessEnv = {}): CloudWorkspaceManager {
  const containers = new WorkspaceContainers(
    loadCloudWorkspaceConfig({ WORKSPACE_MAX_PER_USER: '2', ...env }),
    docker.run,
    () => {
      throw new Error('spawn not used in these tests')
    },
  )
  return new CloudWorkspaceManager({
    store: new CloudWorkspaceStore(dir),
    containers,
    now: () => now,
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-ws-'))
  docker = fakeDocker()
  now = 1_000_000
  manager = build()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('repository input validation', () => {
  it('accepts http and https repository URLs on any host', () => {
    expect(validateRepoUrl(' https://github.com/a/b.git ')).toBe(
      'https://github.com/a/b.git',
    )
    expect(
      validateRepoUrl('http://git.example.internal/team/service.git'),
    ).toBe('http://git.example.internal/team/service.git')
    for (const bad of [
      'git@github.com:a/b.git',
      'file:///etc',
      'ext::sh -c id',
      'https://user:token@github.com/a/b',
      'http://user:token@git.example/a/b',
      'https://github.com/a/b?x=1',
      'https://github.com',
    ]) {
      expect(() => validateRepoUrl(bad), bad).toThrow(CloudWorkspaceError)
    }
  })

  it('rejects refs that could become git options', () => {
    expect(validateRef('main')).toBe('main')
    expect(validateRef('release/1.2')).toBe('release/1.2')
    expect(validateRef('')).toBeUndefined()
    expect(() => validateRef('--upload-pack=x')).toThrow()
    expect(() => validateRef('a..b')).toThrow()
    expect(() => validateRef('a b')).toThrow()
  })
})

describe('container template', () => {
  it('runs hardened, resource-capped, on the isolated network', () => {
    const args = manager.containers.runArgs('abcdef0123456789')
    expect(args).toEqual(
      expect.arrayContaining([
        '--user',
        '1000:1000',
        '--cap-drop',
        'ALL',
        'no-new-privileges',
        '--pids-limit',
        '512',
        '--network',
        'agent-ws',
        'type=volume,src=agent-ws-abcdef0123456789,dst=/workspace',
      ]),
    )
    expect(args.join(' ')).not.toMatch(/privileged|docker\.sock|--volume/)
  })

  it('labels objects with the instance and sweeps only its own containers', async () => {
    const own = build({ WORKSPACE_INSTANCE: 'prod' })
    expect(own.containers.runArgs('abcdef0123456789')).toEqual(
      expect.arrayContaining(['--label', 'agent.workspace.instance=prod']),
    )
    await own.containers.listRunning()
    expect(docker.calls.at(-1)).toEqual(
      expect.arrayContaining([
        '--filter',
        'label=agent.workspace.instance=prod',
      ]),
    )
    expect(() => build({ WORKSPACE_INSTANCE: 'a b' })).toThrow(
      /WORKSPACE_INSTANCE/,
    )
  })

  it('refuses ids that are not plain lowercase hex-like tokens', () => {
    expect(() => manager.containers.containerName('../x')).toThrow()
    expect(() => manager.containers.containerName('ABCDEF0123')).toThrow()
  })

  it('exec passes only explicit env and runs as the workspace user', () => {
    const args = manager.containers.execArgs(
      'abcdef0123456789',
      ['git', 'status'],
      {
        cwd: '/workspace/repo',
        env: { GIT_TERMINAL_PROMPT: '0' },
      },
    )
    expect(args.slice(0, 7)).toEqual([
      'exec',
      '--user',
      '1000:1000',
      '--env',
      'HOME=/home/agent',
      '--env',
      'GIT_TERMINAL_PROMPT=0',
    ])
    expect(args.slice(-3)).toEqual([
      'agent-ws-abcdef0123456789',
      'git',
      'status',
    ])
  })
})

describe('workspace lifecycle', () => {
  it('clones a public repository into the volume and marks it ready', async () => {
    const afterReady = vi.fn()
    manager.setAfterReady(afterReady)
    const created = manager.create({
      ownerEmail: 'Bob@Example.com',
      ownerName: 'Bob',
      repoUrl: 'https://github.com/acme/widgets.git',
      ref: 'main',
    })
    expect(created.status).toBe('provisioning')
    expect(created.name).toBe('widgets')

    const ready = await manager.waitReady(created.id)
    expect(ready.status).toBe('ready')
    expect(afterReady).toHaveBeenCalledOnce()
    expect(afterReady).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: `cloud:${created.id}`,
        cwd: '/workspace/repo',
      }),
    )
    const clone = docker.calls.find(c => c.includes('clone'))!
    expect(clone).toEqual(
      expect.arrayContaining([
        'protocol.allow=never',
        '--depth',
        '1',
        '--no-recurse-submodules',
        '--branch',
        'main',
        '--',
        'https://github.com/acme/widgets.git',
        '/workspace/repo',
      ]),
    )
    expect(docker.calls.some(c => c.includes('user.email'))).toBe(true)
    expect(manager.list('bob@example.com').map(r => r.id)).toEqual([created.id])
  })

  it('records a clone failure and removes the container', async () => {
    docker.failExec = args =>
      args.includes('clone') ? 'fatal: repository not found' : null
    const created = manager.create({
      ownerEmail: 'bob@example.com',
      repoUrl: 'https://github.com/acme/missing',
    })
    await expect(manager.waitReady(created.id)).rejects.toThrow(
      /repository not found/,
    )
    expect(manager.get(created.id)?.status).toBe('error')
    expect(docker.containers.size).toBe(0)
  })

  it('clones a private repository with an in-memory header and stores no token', async () => {
    const token = 'ghp_clone_secret'
    const created = manager.create({
      ownerEmail: 'bob@example.com',
      repoUrl: 'https://github.com/acme/private.git',
      gitToken: token,
    })
    await manager.waitReady(created.id)
    const clone = docker.calls.find(args => args.includes('clone'))
    expect(clone).toEqual(
      expect.arrayContaining([
        '-c',
        gitCloneAuthConfig(token),
        '--',
        'https://github.com/acme/private.git',
        '/workspace/repo',
      ]),
    )
    expect(clone?.join(' ')).not.toContain(token)
    const onDisk = fs.readFileSync(path.join(dir, `${created.id}.json`), 'utf8')
    expect(onDisk).not.toContain(token)
    expect(onDisk).not.toContain(gitTokenBasicValue(token))
    expect(JSON.stringify(manager.get(created.id))).not.toContain(token)
  })

  it('redacts a token that leaks into a clone error', async () => {
    const token = 'ghp_clone_secret'
    docker.failExec = args =>
      args.includes('clone') ? `fatal: auth ${token} rejected` : null
    const created = manager.create({
      ownerEmail: 'bob@example.com',
      repoUrl: 'https://github.com/acme/private.git',
      gitToken: token,
    })
    await expect(manager.waitReady(created.id)).rejects.toThrow(/redacted/)
    const onDisk = fs.readFileSync(path.join(dir, `${created.id}.json`), 'utf8')
    expect(onDisk).not.toContain(token)
    expect(onDisk).toContain('[redacted]')
  })

  it('never seeds agent configuration into a blank repository', async () => {
    const blank = manager.create({ ownerEmail: 'bob@example.com' })
    await manager.waitReady(blank.id)

    const serialized = docker.calls.map(args => args.join(' ')).join('\n')
    expect(serialized).not.toContain('.ai-agent')
    expect(serialized).not.toContain('AGENTS.md')
  })

  it('enforces the per-user limit', async () => {
    await manager.ensureDefault('bob@example.com')
    manager.create({ ownerEmail: 'bob@example.com' })
    expect(() => manager.create({ ownerEmail: 'bob@example.com' })).toThrow(
      /limit/,
    )
    expect(() =>
      manager.create({ ownerEmail: 'amy@example.com' }),
    ).not.toThrow()
  })

  it('ensureDefault reuses a ready workspace', async () => {
    const first = await manager.ensureDefault('bob@example.com')
    const again = await manager.ensureDefault('bob@example.com')
    expect(again.id).toBe(first.id)
    expect(first.source).toEqual({ kind: 'empty' })
  })

  it('recreates a stopped container from the image', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    const name = manager.containers.containerName(ws.id)
    docker.containers.set(name, false)
    await manager.containers.ensureRunning(ws.id)
    expect(docker.calls.some(c => c[0] === 'rm' && c.includes(name))).toBe(true)
    expect(docker.containers.get(name)).toBe(true)
  })

  it('sweeps idle containers but keeps busy ones and the volume', async () => {
    const idle = await manager.ensureDefault('bob@example.com')
    const busy = await manager.ensureDefault('amy@example.com')
    const closed: string[] = []
    manager.setBusyProbe(() => new Set([busy.id]))
    manager.setBeforeStop(async handle => {
      closed.push(handle.environmentId)
    })

    expect(await manager.sweepIdle()).toEqual([])
    now += manager.config.idleMs + 1
    expect(await manager.sweepIdle()).toEqual([idle.id])
    expect(closed).toEqual([`cloud:${idle.id}`])
    expect(docker.calls.some(c => c[0] === 'volume' && c[1] === 'rm')).toBe(
      false,
    )
    expect(manager.get(idle.id)?.status).toBe('ready')
  })

  it('delete removes container, volume and record', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    await manager.remove(ws.id)
    expect(manager.get(ws.id)).toBeUndefined()
    expect(
      docker.calls.some(
        c =>
          c[0] === 'volume' && c[1] === 'rm' && c.includes(`agent-ws-${ws.id}`),
      ),
    ).toBe(true)
  })

  it('refuses stop and delete while any turn is active', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    manager.setBusyProbe(() => new Set([ws.id]))

    await expect(manager.stop(ws.id)).rejects.toMatchObject({ status: 409 })
    await expect(manager.remove(ws.id)).rejects.toMatchObject({ status: 409 })
    expect(manager.get(ws.id)).toBeDefined()
  })

  it('tombstones before awaiting provisioning and never recreates the volume', async () => {
    const created = manager.create({ ownerEmail: 'bob@example.com' })
    await manager.remove(created.id)
    expect(manager.get(created.id)).toBeUndefined()

    const callsAfterDelete = docker.calls.length
    await expect(manager.containers.ensureRunning(created.id)).rejects.toThrow(
      /deleted/,
    )
    expect(docker.calls).toHaveLength(callsAfterDelete)
    expect(docker.containers.size).toBe(0)
  })

  it('disconnects cached environments and rejects their stale filesystem port', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    const registry = new EnvironmentRegistry()
    registry.register(manager.createProvider())
    const connection = await registry.connect(`cloud:${ws.id}`)
    const fsPort = connection.openFs()
    manager.setBeforeStop(async handle => {
      await registry.disconnectEnvironment(handle.environmentId)
    })

    await manager.remove(ws.id)

    expect(registry.getConnectionForEnv(`cloud:${ws.id}`)).toBeUndefined()
    await expect(fsPort.stat('/workspace/repo')).rejects.toThrow(
      /no longer available|deleted/,
    )
  })

  it('makes a deleted workspace unavailable to scheduled turns', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    const session = { workspace: manager.handleFor(ws.id) }
    expect(isScheduledWorkspaceAvailable(session, manager)).toBe(true)

    await manager.remove(ws.id)
    expect(isScheduledWorkspaceAvailable(session, manager)).toBe(false)
  })

  it('marks imports cut off by a restart as failed', () => {
    const created = manager.create({ ownerEmail: 'bob@example.com' })
    const restarted = build()
    restarted.failInterruptedProvisioning()
    expect(restarted.get(created.id)?.status).toBe('error')
  })
})

describe('repository access gate', () => {
  function gated(sequence: RepoAccess[]) {
    const probe = vi.fn(async (_repoUrl: string, _token?: string) => {
      const next = sequence.shift()
      if (!next) throw new Error('unexpected probe')
      return next
    })
    const gatedManager = new CloudWorkspaceManager({
      store: new CloudWorkspaceStore(dir),
      containers: manager.containers,
      now: () => now,
      probeRepo: probe,
    })
    return { probe, manager: gatedManager }
  }

  it('drops a token for a public repository', async () => {
    const { manager: gatedManager, probe } = gated(['public'])
    await expect(
      gatedManager.authorizeRepository(
        'https://github.com/acme/widgets.git',
        'ghp_unused',
      ),
    ).resolves.toEqual({
      url: 'https://github.com/acme/widgets.git',
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]?.[1]).toBeUndefined()
    expect(gatedManager.list('bob@example.com')).toEqual([])
  })

  it('does not write a record when a private repository has no token', async () => {
    const { manager: gatedManager } = gated(['auth-required'])
    await expect(
      gatedManager.authorizeRepository('https://github.com/acme/private.git'),
    ).rejects.toMatchObject({ status: 400 })
    expect(gatedManager.list('bob@example.com')).toEqual([])
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.json'))).toEqual(
      [],
    )
  })

  it('does not write a record when the token is rejected', async () => {
    const { manager: gatedManager, probe } = gated([
      'auth-required',
      'auth-required',
    ])
    await expect(
      gatedManager.authorizeRepository(
        'https://github.com/acme/private.git',
        'ghp_wrong',
      ),
    ).rejects.toThrow(/rejected/)
    expect(probe.mock.calls[1]?.[1]).toBe('ghp_wrong')
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.json'))).toEqual(
      [],
    )
  })
})

describe('cloud environments', () => {
  it('resolves cloud ids only through the cloud provider', async () => {
    const ws = await manager.ensureDefault('bob@example.com')
    const registry = new EnvironmentRegistry()
    registry.register(manager.createProvider())
    const env = await registry.resolve(`cloud:${ws.id}`)
    expect(env).toMatchObject({
      id: `cloud:${ws.id}`,
      kind: 'cloud',
      defaultCwd: '/workspace/repo',
    })
    await expect(registry.resolve('cloud:0000000000000000')).rejects.toThrow(
      /not found/,
    )
    expect(await registry.listAll()).toEqual([])
  })
})
