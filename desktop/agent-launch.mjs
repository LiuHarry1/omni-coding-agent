/**
 * Desktop agent spawn helpers (mirrors src/execution/worker-paths.ts for Electron).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export function agentNativePath(appRoot, slug) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return path.join(appRoot, 'dist', 'agent', `${slug}-agent${ext}`)
}

export function agentBundlePath(appRoot, slug) {
  return path.join(appRoot, 'dist', 'agent', `${slug}-agent.cjs`)
}

export function runtimeNodeModulesPath(appRoot) {
  return path.join(appRoot, 'dist', 'agent', 'runtime', 'node_modules')
}

/**
 * Packaged: resources/workspace-seed next to the app.
 * Dev: repo deploy/desktop/workspace-seed.
 */
export function resolveWorkspaceSeedDir(
  appRoot,
  { packaged = false, resourcesPath } = {},
) {
  if (packaged && resourcesPath) {
    const packed = path.join(resourcesPath, 'workspace-seed')
    if (fs.existsSync(packed)) return packed
  }
  const dev = path.join(appRoot, 'deploy', 'desktop', 'workspace-seed')
  if (fs.existsSync(dev)) return dev
  return null
}

/** Trusted ripgrep shipped beside the packaged app (outside app.asar). */
export function resolveBundledRipgrepPath({
  packaged = false,
  resourcesPath,
  platform = process.platform,
} = {}) {
  if (!packaged || !resourcesPath) return null
  const executable = platform === 'win32' ? 'rg.exe' : 'rg'
  const candidate = path.join(resourcesPath, 'ripgrep', executable)
  try {
    return fs.statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

/**
 * App-dir basename for user state (mirrors src/utils/app-dir.ts).
 * Override with AI_AGENT_DIR (leading dot added if missing).
 */
export function resolveAppDirName(env = process.env) {
  const raw = env.AI_AGENT_DIR?.trim()
  if (!raw) return '.ai-agent'
  return raw.startsWith('.') ? raw : `.${raw}`
}

/**
 * Packaged desktop default workspace: ~/.ai-agent/workspace (OpenClaw-style).
 * Not the install dir / Program Files. Dev leaves WORKSPACE unset so cwd stays
 * the repo; UI-picked folders override via the agent API.
 */
export function resolveDefaultDesktopWorkspace({
  packaged = false,
  homeDir,
  env = process.env,
} = {}) {
  if (!packaged || !homeDir) return null
  return path.join(homeDir, resolveAppDirName(env), 'workspace')
}

export function resolveDesktopDataRoot(homeDir, env = process.env) {
  if (!homeDir) return null
  return path.join(homeDir, resolveAppDirName(env))
}

/** Return the trusted app-data root, rejecting roots and symlink escapes. */
export function assertSafeDesktopDataRoot(target, homeDir) {
  if (!target || !homeDir) throw new Error('Desktop data root is unavailable')
  const home = path.resolve(homeDir)
  const root = path.resolve(target)
  if (root === home || path.dirname(root) !== home) {
    throw new Error('Refusing to reset a path outside the home directory')
  }
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Refusing to reset a non-directory or symbolic link')
    }
    const realHome = fs.realpathSync(home)
    const realRoot = fs.realpathSync(root)
    if (path.dirname(realRoot) !== realHome) {
      throw new Error('Desktop data root resolves outside the home directory')
    }
  }
  return root
}

export function buildAgentSpawnEnv(
  appRoot,
  port,
  baseEnv = process.env,
  { packaged = false, resourcesPath, workspace, appDataDir } = {},
) {
  const env = {
    ...baseEnv,
    PORT: String(port),
    AGENT_ROOT: appRoot,
  }
  // Packaged desktop owns this reserved variable. Never accept an inherited
  // path in that mode; only expose the file under Electron's resourcesPath.
  if (packaged) {
    delete env.BUNDLED_RG_PATH
    const bundledRg = resolveBundledRipgrepPath({
      packaged,
      resourcesPath,
    })
    if (bundledRg) env.BUNDLED_RG_PATH = bundledRg
  }
  if (workspace && env.WORKSPACE == null) {
    env.WORKSPACE = workspace
  }
  if (appDataDir) {
    env.AI_AGENT_DATA_DIR = appDataDir
  }
  const seedDir = resolveWorkspaceSeedDir(appRoot, { packaged, resourcesPath })
  if (seedDir && env.WORKSPACE_SEED_DIR == null) {
    env.WORKSPACE_SEED_DIR = seedDir
  }
  const runtimeModules = runtimeNodeModulesPath(appRoot)
  if (!fs.existsSync(runtimeModules)) {
    return env
  }
  const sep = path.delimiter
  const existing = env.NODE_PATH?.trim()
  env.NODE_PATH = existing
    ? `${runtimeModules}${sep}${existing}`
    : runtimeModules
  return env
}

/**
 * Unpackaged desktop: use the Node that launched npm so native addons
 * (sharp) match ABI. Packaged ELECTRON_RUN_AS_NODE keeps a pure-JS JPEG/PNG
 * fallback when the Electron ABI cannot load sharp.node.
 */
export function resolveAgentNodeExecPath(
  electronExecPath,
  { packaged = false } = {},
) {
  if (packaged) return electronExecPath
  const npmNode = process.env.npm_node_execpath
  if (npmNode && fs.existsSync(npmNode)) return npmNode
  return electronExecPath
}

export function resolveTsxCli(appRoot) {
  return path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
}

/**
 * HTTP/ACP agent launch.
 *
 * Packaged desktop always uses the CJS bundle under Electron's
 * ELECTRON_RUN_AS_NODE (real Node `ws`). The Bun `--compile` exe is kept for
 * CLI, but Playwright connectOverCDP hangs against the in-process CDP
 * WebSocket when the agent itself is that native binary.
 *
 * Dev uses tsx + start.js, same as `npm start`.
 */
export function resolveAgentLaunch(appRoot, slug, { packaged = false } = {}) {
  if (!packaged) {
    const tsxCli = resolveTsxCli(appRoot)
    const startScript = path.join(appRoot, 'start.js')
    if (fs.existsSync(tsxCli) && fs.existsSync(startScript)) {
      return { kind: 'tsx', tsxCli, startScript }
    }
  }

  const bundled = agentBundlePath(appRoot, slug)
  if (packaged || fs.existsSync(bundled)) {
    if (!fs.existsSync(bundled)) {
      return {
        kind: 'error',
        message:
          `Missing bundled agent:\n${bundled}\n\n` +
          'Rebuild with: npm run build:desktop && npm run desktop:pack:win',
      }
    }
    return { kind: 'bundle', entry: bundled }
  }

  const native = agentNativePath(appRoot, slug)
  if (fs.existsSync(native)) {
    return { kind: 'native', entry: native }
  }

  const tsxCli = resolveTsxCli(appRoot)
  const startScript = path.join(appRoot, 'start.js')
  if (!fs.existsSync(tsxCli)) {
    return {
      kind: 'error',
      message:
        `Missing dev runtime:\n${tsxCli}\n\n` +
        'Run `npm install`, or build the bundled agent with `npm run build:agent`.',
    }
  }
  return { kind: 'tsx', tsxCli, startScript }
}
