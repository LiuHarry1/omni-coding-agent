#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const options = new Set(process.argv.slice(2))
const supportedOptions = new Set(['--build-only', '--skip-build', '--help'])
const unknownOptions = [...options].filter(
  option => !supportedOptions.has(option),
)

if (unknownOptions.length > 0) {
  console.error(`[cloud-dev] Unknown option(s): ${unknownOptions.join(', ')}`)
  process.exit(2)
}

if (options.has('--help')) {
  console.log(`Usage: npm run cloud:start [-- --skip-build]

Build and start a local cloud-profile Coding Agent backed by Docker.

Options:
  --skip-build  Reuse the existing web build and workspace image.
  --build-only  Build the web UI, worker, and workspace image, then exit.`)
  process.exit(0)
}

if (options.has('--build-only') && options.has('--skip-build')) {
  console.error('[cloud-dev] --build-only and --skip-build cannot be combined.')
  process.exit(2)
}

function valueOr(name, fallback) {
  const value = process.env[name]?.trim()
  return value || fallback
}

function run(command, args, description) {
  console.log(`[cloud-dev] ${description}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(`[cloud-dev] ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const image = valueOr('WORKSPACE_IMAGE', 'agent-workspace:latest')

if (!options.has('--skip-build')) {
  run(npmCommand, ['run', 'build:web'], 'Building the web UI...')
  run(npmCommand, ['run', 'build:worker'], 'Building the workspace worker...')
  run(
    'docker',
    ['build', '--file', 'deploy/Dockerfile.workspace', '--tag', image, '.'],
    `Building Docker workspace image ${image}...`,
  )
}

if (options.has('--build-only')) {
  console.log(`[cloud-dev] Cloud build is ready (${image}).`)
  process.exit(0)
}

const dataRoot = path.resolve(
  valueOr(
    'BAIZE_CLOUD_DEV_DIR',
    path.join(homedir(), '.ai-agent', 'cloud-dev'),
  ),
)
const isolatedHome = path.join(dataRoot, 'home')
const processDataDir = path.join(dataRoot, 'runtime')
const controlPlaneWorkspace = path.join(dataRoot, 'control-plane')

for (const directory of [isolatedHome, processDataDir, controlPlaneWorkspace]) {
  mkdirSync(directory, { recursive: true })
}

const env = {
  ...process.env,
  AI_AGENT_DATA_DIR: processDataDir,
  AI_AGENT_MANAGED_DIR: valueOr(
    'AI_AGENT_MANAGED_DIR',
    path.join(repoRoot, 'deploy', 'managed'),
  ),
  AUTH_ENABLED: 'false',
  BAIZE_RUNTIME_PROFILE: 'cloud',
  CLOUD_WORKSPACES: 'docker',
  // Keep Docker Desktop's context/socket discoverable after HOME is isolated.
  DOCKER_CONFIG: valueOr('DOCKER_CONFIG', path.join(homedir(), '.docker')),
  HOME: isolatedHome,
  HOST: '127.0.0.1',
  PORT: valueOr('PORT', '4567'),
  SERVE_STATIC: '1',
  WORKSPACE: controlPlaneWorkspace,
  WORKSPACE_IMAGE: image,
  WORKSPACE_INSTANCE: valueOr('WORKSPACE_INSTANCE', 'baize-local-cloud'),
  WORKSPACE_NETWORK: valueOr(
    'WORKSPACE_NETWORK',
    'baize-local-cloud-workspaces',
  ),
  WORKSPACE_SEED_DIR: '',
}

if (process.platform === 'win32') {
  env.USERPROFILE = isolatedHome
}

console.log(`[cloud-dev] Local data: ${dataRoot}`)
console.log(
  `[cloud-dev] Starting cloud profile at http://localhost:${env.PORT}`,
)
console.log('[cloud-dev] Press Ctrl+C to stop the control plane.')

const server = spawn(npmCommand, ['start'], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
})

server.on('error', error => {
  console.error(`[cloud-dev] Failed to start: ${error.message}`)
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!server.killed) server.kill(signal)
  })
}

server.on('exit', (code, signal) => {
  if (code !== null) {
    process.exitCode = code
    return
  }
  process.exitCode = signal === 'SIGINT' ? 130 : 1
})
