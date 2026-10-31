import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { getBrowserLogsSessionDir } from '../core/session-paths.js'
import { AUTH_COOKIE_NAME, slugifyEmail } from '../server/auth/identity.js'
import { createRouter } from '../server/router.js'
import {
  createDurableRun,
  resetRunManagerForTesting,
} from '../services/runs/run-manager.js'
import { createSession } from '../session/store.js'
import { getChatUploadsDir } from '../utils/chat-uploads.js'
import { runWithRequestScope } from '../utils/request-scope.js'

function b64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function token(secret: string, email: string, role: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      sub: email,
      username: email,
      role,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  const signature = b64url(
    crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  )
  return `${header}.${payload}.${signature}`
}

async function request(base: string, url: string, bearer?: string) {
  return fetch(`${base}${url}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
  })
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-auth-'))
  const usersRoot = path.join(root, 'users')
  const aliceHome = path.join(usersRoot, slugifyEmail('alice@example.com'))
  const secret = 'test-session-artifact-secret'
  const previous = {
    AUTH_ENABLED: process.env.AUTH_ENABLED,
    JWT_SECRET: process.env.JWT_SECRET,
    USERS_ROOT: process.env.USERS_ROOT,
    WORKSPACE_SEED_DIR: process.env.WORKSPACE_SEED_DIR,
  }
  process.env.AUTH_ENABLED = 'true'
  process.env.JWT_SECRET = secret
  process.env.USERS_ROOT = usersRoot
  process.env.WORKSPACE_SEED_DIR = ''
  fs.mkdirSync(aliceHome, { recursive: true })

  let server: http.Server | undefined
  try {
    const session = runWithRequestScope(
      { agentHome: aliceHome, cwd: aliceHome },
      () => createSession('alice@example.com'),
    )
    const run = runWithRequestScope(
      { agentHome: aliceHome, cwd: aliceHome },
      () =>
        createDurableRun({
          sessionId: session.id,
          ownerEmail: 'alice@example.com',
          ownerRole: 'user',
          agentHome: aliceHome,
          cwd: aliceHome,
          requestPayload: { message: 'private durable task' },
        }),
    )
    const uploadDir = getChatUploadsDir(session.id)
    fs.mkdirSync(uploadDir, { recursive: true })
    fs.writeFileSync(
      path.join(uploadDir, 'preview.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    const browserDir = getBrowserLogsSessionDir(session.id, aliceHome)
    fs.mkdirSync(browserDir, { recursive: true })
    fs.copyFileSync(
      path.join(uploadDir, 'preview.png'),
      path.join(browserDir, 'tool-call.png'),
    )
    const chartPath = path.join(aliceHome, 'charts', 'auth-test.html')
    fs.mkdirSync(path.dirname(chartPath), { recursive: true })
    fs.writeFileSync(
      chartPath,
      '<!doctype html><title>Authenticated chart</title>',
    )

    const router = createRouter({ staticDir: path.join(root, 'static') })
    server = http.createServer((req, res) => void router(req, res))
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const alice = token(secret, 'alice@example.com', 'user')
    const bob = token(secret, 'bob@example.com', 'user')
    const superUser = token(secret, 'super@advantest.com', 'super')
    const preview = `/workspace/preview?path=${encodeURIComponent(chartPath)}`
    const upload = `/sessions/${session.id}/uploads/preview.png`
    const screenshot = `/sessions/${session.id}/browser/tool-call.png`
    const runPath = `/runs/${run.runId}`

    assert.equal((await request(base, preview)).status, 401)
    assert.equal((await request(base, preview, alice)).status, 200)
    assert.equal((await request(base, preview, bob)).status, 403)
    assert.equal((await request(base, preview, superUser)).status, 200)

    const cookie = (jwt: string) => ({ Cookie: `${AUTH_COOKIE_NAME}=${jwt}` })
    assert.equal(
      (await fetch(`${base}${preview}`, { headers: cookie(alice) })).status,
      200,
      'same-origin preview navigation can auth via cookie',
    )
    assert.equal(
      (await fetch(`${base}/code${preview}`, { headers: cookie(alice) }))
        .status,
      200,
      'KnowBot /code/ mount still auths preview via cookie',
    )
    assert.equal(
      (await fetch(`${base}${preview}`, { headers: cookie(bob) })).status,
      403,
    )

    const cookieOnly = (url: string, init?: RequestInit) =>
      fetch(`${base}${url}`, { ...init, headers: cookie(alice) })
    assert.equal(
      (await cookieOnly('/sessions', { method: 'POST' })).status,
      401,
      'cookie grants no authority over mutating routes',
    )
    assert.equal(
      (await cookieOnly('/sessions')).status,
      401,
      'cookie auth is limited to the preview navigation path',
    )
    assert.equal(
      (await cookieOnly(upload)).status,
      401,
      'session artifacts still require the bearer header',
    )

    assert.equal((await request(base, upload, alice)).status, 200)
    assert.equal((await request(base, upload, bob)).status, 404)
    assert.equal((await request(base, upload, superUser)).status, 200)

    assert.equal((await request(base, screenshot, alice)).status, 200)
    assert.equal((await request(base, screenshot, bob)).status, 404)
    assert.equal(
      (await request(base, screenshot, superUser)).status,
      200,
      'super resolves screenshot from the session owner agent home',
    )
    assert.equal(
      (
        await request(
          base,
          `/sessions/${session.id}/uploads/${encodeURIComponent('../preview.png')}`,
          alice,
        )
      ).status,
      404,
    )

    assert.equal((await request(base, runPath)).status, 401)
    const runResponse = await request(base, runPath, alice)
    assert.equal(runResponse.status, 200)
    const publicRun = (await runResponse.json()) as Record<string, unknown>
    assert.equal(publicRun.runId, run.runId)
    assert.equal(publicRun.ownerEmail, undefined)
    assert.equal(publicRun.ownerRole, undefined)
    assert.equal(publicRun.agentHome, undefined)
    assert.equal(publicRun.requestPayload, undefined)
    assert.equal((await request(base, runPath, bob)).status, 404)
    assert.equal((await request(base, runPath, superUser)).status, 200)
    assert.equal(
      (
        await fetch(`${base}${runPath}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bob}` },
        })
      ).status,
      404,
    )
    assert.equal(
      (
        await fetch(`${base}${runPath}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${alice}` },
        })
      ).status,
      200,
    )
    const terminalStream = await request(
      base,
      `${runPath}/stream?after_seq=0`,
      alice,
    )
    assert.equal(terminalStream.status, 200)
    assert.equal(terminalStream.headers.get('x-run-id'), run.runId)
    assert.match(await terminalStream.text(), /: connected/)

    console.log('session artifact and chart preview auth tests OK')
  } finally {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()))
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetRunManagerForTesting()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
