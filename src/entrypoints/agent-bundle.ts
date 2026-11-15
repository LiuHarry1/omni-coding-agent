/**
 * Single-file desktop/CLI agent entry (esbuild → dist/agent/{slug}-agent.cjs).
 * Same start as start.js, then the mode dispatcher in cli.ts.
 */
import { applyRuntimeModulePath } from '../execution/worker-paths.js'

applyRuntimeModulePath()

import { readFileSync } from 'fs'
import { join } from 'path'
import { getRepoRoot } from '../execution/worker-paths.js'
import { handleEarlyArgs } from './early-args.js'

function readPackageVersion(): string {
  try {
    const pkgPath = join(getRepoRoot(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '1.0.0'
  } catch {
    return '1.0.0'
  }
}

handleEarlyArgs({ program: 'baize-agent', readVersion: readPackageVersion })

void import('./cli.js')
