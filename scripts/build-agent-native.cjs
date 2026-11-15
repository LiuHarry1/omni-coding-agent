/**
 * Compile the unified agent to a native executable with Bun (optional CLI artifact).
 * Desktop Electron does not launch this file — Playwright connectOverCDP hangs
 * inside the compiled binary. Packaged desktop uses the CJS bundle instead.
 * Requires Bun on the build machine. Falls back gracefully when bun is missing.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand.json'), 'utf8'))
const slug = brand.slug || 'baize'
const entry = path.join(root, 'src', 'entrypoints', 'agent-bundle.ts')
const outDir = path.join(root, 'dist', 'agent')
const outName =
  process.platform === 'win32' ? `${slug}-agent.exe` : `${slug}-agent`
const outfile = path.join(outDir, outName)

const external = [
  'sharp',
  'playwright-core',
  '@img/sharp-libvips-linux-x64',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-darwin-x64',
  '@img/sharp-libvips-darwin-arm64',
  '@img/sharp-win32-x64',
  '@img/sharp-win32-ia32',
  '@img/sharp-wasm32',
]

function bunAvailable() {
  const probe = spawnSync('bun', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return probe.status === 0
}

function main() {
  if (!fs.existsSync(entry)) {
    throw new Error(`Missing agent entry: ${entry}`)
  }
  if (!bunAvailable()) {
    console.warn(
      '[build-agent-native] bun not found — skipping native compile (CJS bundle still usable)',
    )
    return
  }

  fs.mkdirSync(outDir, { recursive: true })

  const args = [
    'build',
    entry,
    '--compile',
    '--minify',
    '--sourcemap',
    `--outfile=${outfile}`,
    ...external.flatMap(pkg => ['--external', pkg]),
  ]

  console.log(`[build-agent-native] bun ${args.join(' ')}`)
  const result = spawnSync('bun', args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error('bun compile failed')
  }

  const versionPath = path.join(outDir, 'version.json')
  let versionDoc = {}
  if (fs.existsSync(versionPath)) {
    versionDoc = JSON.parse(fs.readFileSync(versionPath, 'utf8'))
  }
  versionDoc.nativeArtifact = outName
  versionDoc.nativeBuiltAt = new Date().toISOString()
  fs.writeFileSync(versionPath, JSON.stringify(versionDoc, null, 2))

  console.log(`[build-agent-native] Wrote ${outfile}`)
}

main()
