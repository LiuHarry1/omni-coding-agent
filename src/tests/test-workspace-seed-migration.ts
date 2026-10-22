import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyWorkspaceSeedMigrations } from '../core/workspace-seed.js'

const root = await mkdtemp(path.join(tmpdir(), 'workspace-seed-migration-'))
const workspace = path.join(root, 'workspace')
const seed = path.join(root, 'seed')
const relativeAssistant = path.join('.ai-agent', 'agents', 'assistant.md')
const workspaceAssistant = path.join(workspace, relativeAssistant)
const seedAssistant = path.join(seed, relativeAssistant)
const legacy =
  '- The shell runs as the user on their real machine, with no sandbox. On Windows, use `PowerShell` for every command — `Bash` needs Git for Windows, which most users do not have. On macOS / Linux, use `Bash`.'
const current =
  '- The shell runs as the user on their real machine, with no sandbox. On Windows, prefer `Bash` when that tool is available; if Git Bash is not installed, `Bash` is omitted and you must use `PowerShell`. Never invoke `powershell.exe` or `pwsh` from `Bash`; call the `PowerShell` tool directly. On macOS / Linux, use `Bash`.'

try {
  await mkdir(path.dirname(workspaceAssistant), { recursive: true })
  await mkdir(path.dirname(seedAssistant), { recursive: true })
  await writeFile(seedAssistant, `before\n${current}\nafter\n`, 'utf-8')
  await writeFile(
    workspaceAssistant,
    `custom user prefix\n${legacy}\ncustom user suffix\n`,
    'utf-8',
  )

  assert.equal(applyWorkspaceSeedMigrations(workspace, seed), true)
  const migrated = await readFile(workspaceAssistant, 'utf-8')
  assert.match(migrated, /custom user prefix/)
  assert.match(migrated, /custom user suffix/)
  assert.ok(migrated.includes(current))
  assert.ok(!migrated.includes(legacy))
  assert.equal(
    applyWorkspaceSeedMigrations(workspace, seed),
    false,
    'migration is idempotent',
  )

  await writeFile(
    workspaceAssistant,
    'fully customized assistant without legacy text\n',
    'utf-8',
  )
  assert.equal(
    applyWorkspaceSeedMigrations(workspace, seed),
    false,
    'unrelated user customization is preserved',
  )
  assert.equal(
    await readFile(workspaceAssistant, 'utf-8'),
    'fully customized assistant without legacy text\n',
  )

  console.log('workspace seed migration checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
