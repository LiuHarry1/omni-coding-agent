import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function candidateRoots() {
  const configured = String(process.env.NODE_PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  return [
    ...configured,
    '/opt/pptx-tools/node_modules',
    '/usr/local/lib/node_modules',
  ]
}

export function loadRuntimePackage(name) {
  try {
    return require(name)
  } catch (initialError) {
    for (const root of candidateRoots()) {
      try {
        return require(path.join(root, name))
      } catch {
        // Try the next Baix runtime package root.
      }
    }
    const roots = candidateRoots().join(', ') || '(none)'
    throw new Error(
      `Missing Create-PPT runtime package "${name}". ` +
        `Checked local node_modules and: ${roots}. ` +
        `Rebuild the Baix workspace image with deploy/Dockerfile.workspace.`,
      { cause: initialError },
    )
  }
}

export function tryLoadRuntimePackage(name) {
  try {
    return loadRuntimePackage(name)
  } catch {
    return null
  }
}
