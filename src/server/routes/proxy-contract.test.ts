import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

function viteAgentRoutes(): string[] {
  const source = fs.readFileSync(
    path.join(repoRoot, 'web/vite.config.js'),
    'utf8',
  )
  const routes = [...source.matchAll(/^\s+'(\/[^']+)':/gm)].map(
    match => match[1],
  )
  return routes.filter(route => route !== '/sso' && route !== '/api/auth')
}

function nginxAgentRoutes(): Set<string> {
  const source = fs.readFileSync(
    path.join(repoRoot, 'deploy/nginx.sso-proxy.conf'),
    'utf8',
  )
  const match = source.match(/location ~ \^\/\(([^)]+)\)\(\/\|\$\)/)
  expect(match, 'agent API location in nginx.sso-proxy.conf').not.toBeNull()
  return new Set(match![1].split('|').map(route => `/${route}`))
}

describe('SSO proxy contract', () => {
  it('proxies every Vite agent API route through nginx', () => {
    const nginxRoutes = nginxAgentRoutes()
    expect(viteAgentRoutes().filter(route => !nginxRoutes.has(route))).toEqual(
      [],
    )
  })

  it('includes all cloud extension APIs', () => {
    expect([...nginxAgentRoutes()]).toEqual(
      expect.arrayContaining([
        '/capabilities',
        '/user-config',
        '/extension-config',
        '/marketplaces',
      ]),
    )
  })
})
