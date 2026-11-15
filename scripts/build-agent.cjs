/**
 * Bundle the HTTP/ACP/stdio agent to dist/agent/{slug}-agent.cjs (CJS for Node).
 * Desktop Electron spawns this artifact instead of tsx + start.js + src/**.
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand.json'), 'utf8'))
const slug = brand.slug || 'baize'
const agentFile = `${slug}-agent.cjs`
const outfile = path.join(root, 'dist', 'agent', agentFile)
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Native or heavy deps resolved at runtime from node_modules next to AGENT_ROOT. */
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

async function main() {
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'entrypoints', 'agent-bundle.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    external,
    sourcemap: true,
    logLevel: 'info',
    define: {
      // CJS has no import.meta; packaged runs set AGENT_ROOT. Same stub as
      // build-worker.cjs so worker-paths moduleDir/moduleRequire don't warn.
      'import.meta.url': JSON.stringify(`file:///${agentFile}`),
    },
  })

  const builtAt = new Date().toISOString()
  const versionFile = path.join(root, 'dist', 'agent', 'version.json')
  const version = `${pkg.version || '1.0.0'}+${builtAt.replace(/[-:.]/g, '').replace('T', '').replace('Z', '')}`
  fs.writeFileSync(
    versionFile,
    JSON.stringify({ version, builtAt, artifact: agentFile }, null, 2),
  )

  const agentDir = path.join(root, 'dist', 'agent')
  for (const name of fs.readdirSync(agentDir)) {
    if (!/^[a-z0-9]+-agent\.cjs(\.map)?$/i.test(name)) continue
    if (name === agentFile || name === `${agentFile}.map`) continue
    try {
      fs.unlinkSync(path.join(agentDir, name))
    } catch {
      /* ignore */
    }
  }

  console.log(`Wrote ${outfile}`)
  console.log(`Wrote ${versionFile}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
