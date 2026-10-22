/**
 * Seed a workspace from a baked-in template directory (`WORKSPACE_SEED_DIR`).
 *
 * SSO: first login copies into the user workspace.
 * Desktop: Electron sets WORKSPACE_SEED_DIR; discovery via
 * loadWorkspaceContributions applies the seed once (marker file).
 *
 * Existing files are never overwritten (`errorOnExist: false`). Narrow,
 * content-matched migrations may update obsolete product-owned seed text.
 */
import * as fs from 'fs'
import * as path from 'path'

export const WORKSPACE_SEEDED_MARKER = '.workspace-seeded'

const DEFAULT_SEED_DIR = '/opt/workspace-seed'
const ASSISTANT_RELATIVE_PATH = path.join('.ai-agent', 'agents', 'assistant.md')
const LEGACY_WINDOWS_SHELL_GUIDANCE =
  '- The shell runs as the user on their real machine, with no sandbox. On Windows, use `PowerShell` for every command — `Bash` needs Git for Windows, which most users do not have. On macOS / Linux, use `Bash`.'
const CURRENT_WINDOWS_SHELL_GUIDANCE =
  '- The shell runs as the user on their real machine, with no sandbox. On Windows, prefer `Bash` when that tool is available; if Git Bash is not installed, `Bash` is omitted and you must use `PowerShell`. Never invoke `powershell.exe` or `pwsh` from `Bash`; call the `PowerShell` tool directly. On macOS / Linux, use `Bash`.'

/** Resolved seed dir, or null when seeding is disabled / nothing to copy. */
export function getWorkspaceSeedDir(): string | null {
  const raw = process.env.WORKSPACE_SEED_DIR
  if (raw != null && raw.trim() === '') return null

  const dir = path.resolve(raw?.trim() || DEFAULT_SEED_DIR)
  if (!fs.existsSync(dir)) return null

  try {
    if (fs.readdirSync(dir).length === 0) return null
  } catch {
    return null
  }

  return dir
}

function copyEntry(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    force: false,
    errorOnExist: false,
  })
}

/**
 * Copy everything under `seedDir` into `userWorkspace` without overwriting
 * existing paths. Returns true when at least one entry was copied.
 */
export function applyWorkspaceSeed(
  userWorkspace: string,
  seedDir: string,
): boolean {
  let copied = false
  for (const name of fs.readdirSync(seedDir)) {
    if (name === WORKSPACE_SEEDED_MARKER) continue
    copyEntry(path.join(seedDir, name), path.join(userWorkspace, name))
    copied = true
  }
  return copied
}

function writeSeedMarker(userWorkspace: string, seedDir: string): void {
  const markerPath = path.join(userWorkspace, WORKSPACE_SEEDED_MARKER)
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        seedDir,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
}

/**
 * Upgrade the exact obsolete Desktop assistant instruction without replacing
 * the file or touching customized surrounding content.
 */
export function applyWorkspaceSeedMigrations(
  userWorkspace: string,
  seedDir: string,
): boolean {
  const seededAssistant = path.join(seedDir, ASSISTANT_RELATIVE_PATH)
  const userAssistant = path.join(userWorkspace, ASSISTANT_RELATIVE_PATH)
  if (!fs.existsSync(seededAssistant) || !fs.existsSync(userAssistant)) {
    return false
  }

  const seedText = fs.readFileSync(seededAssistant, 'utf-8')
  const userText = fs.readFileSync(userAssistant, 'utf-8')
  if (
    !seedText.includes(CURRENT_WINDOWS_SHELL_GUIDANCE) ||
    !userText.includes(LEGACY_WINDOWS_SHELL_GUIDANCE)
  ) {
    return false
  }

  fs.writeFileSync(
    userAssistant,
    userText.replace(
      LEGACY_WINDOWS_SHELL_GUIDANCE,
      CURRENT_WINDOWS_SHELL_GUIDANCE,
    ),
    'utf-8',
  )
  console.log(`[workspace] migrated shell guidance in ${userAssistant}`)
  return true
}

/**
 * On first use of a workspace, copy the baked seed template.
 * Idempotent — safe to call on every request that discovers the workspace.
 */
export function seedUserWorkspaceIfNeeded(userWorkspace: string): boolean {
  const markerPath = path.join(userWorkspace, WORKSPACE_SEEDED_MARKER)
  if (fs.existsSync(markerPath)) {
    const seedDir = getWorkspaceSeedDir()
    return seedDir
      ? applyWorkspaceSeedMigrations(userWorkspace, seedDir)
      : false
  }

  const raw = process.env.WORKSPACE_SEED_DIR
  if (raw != null && raw.trim() === '') {
    writeSeedMarker(userWorkspace, '')
    return false
  }

  const seedDir = getWorkspaceSeedDir()
  if (!seedDir) return false

  try {
    applyWorkspaceSeed(userWorkspace, seedDir)
    writeSeedMarker(userWorkspace, seedDir)
    console.log(`[workspace] seeded ${userWorkspace} from ${seedDir}`)
    return true
  } catch (err) {
    console.error(
      `[workspace] seed failed for ${userWorkspace}: ${(err as Error).message}`,
    )
    return false
  }
}
