import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sshSpawn: vi.fn(),
}))

vi.mock('./ssh-exec.js', () => ({
  sshSpawn: mocks.sshSpawn,
}))

import { SshFsPort } from './ssh-fs.js'

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.kill = vi.fn()
  return child
}

function finish(child: FakeChild, stdout = ''): void {
  if (stdout) child.stdout.write(stdout)
  child.stdout.end()
  child.stderr.end()
  child.exitCode = 0
  child.emit('close', 0)
}

describe('SshFsPort request control', () => {
  const children: FakeChild[] = []

  beforeEach(() => {
    children.length = 0
    mocks.sshSpawn.mockReset()
    mocks.sshSpawn.mockImplementation(() => {
      const child = fakeChild()
      children.push(child)
      return child
    })
  })

  it('limits concurrent SSH filesystem commands per host', async () => {
    const port = new SshFsPort(
      { alias: 'dev', hostName: 'dev.example.test' },
      2,
    )
    const requests = [port.run('one'), port.run('two'), port.run('three')]

    await vi.waitFor(() => expect(children).toHaveLength(2))
    finish(children[0]!)
    await vi.waitFor(() => expect(children).toHaveLength(3))
    finish(children[1]!)
    finish(children[2]!)

    await expect(Promise.all(requests)).resolves.toHaveLength(3)
  })

  it('coalesces identical concurrent metadata reads', async () => {
    const port = new SshFsPort({
      alias: 'dev',
      hostName: 'dev.example.test',
    })
    const first = port.realpath('/srv/repo')
    const second = port.realpath('/srv/repo')

    await vi.waitFor(() => expect(children).toHaveLength(1))
    finish(children[0]!, '/srv/repo\n')

    await expect(Promise.all([first, second])).resolves.toEqual([
      '/srv/repo',
      '/srv/repo',
    ])
    expect(mocks.sshSpawn).toHaveBeenCalledTimes(1)
  })
})
