/**
 * Subagent Agent Memory — paths, parse, prompt, permissions, mentions.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getAgentMemoryDir,
  isAgentMemoryPath,
  loadAgentMemoryPrompt,
  sanitizeAgentTypeForPath,
  parseAgentMemoryScope,
} from '../tools/AgentTool/agentMemory.js'
import {
  checkAgentMemorySnapshot,
  initializeFromSnapshot,
  getSnapshotDirForAgent,
} from '../tools/AgentTool/agentMemorySnapshot.js'
import { parseAgentFromMarkdown } from '../tools/AgentTool/mergeAgents.js'
import { extractAgentMentions } from '../utils/attachments/extract-mentions.js'
import { extractAtMentionedFiles } from '../utils/attachments/extract-mentions.js'
import { resolvePrefetchMemoryDirs } from '../services/auto-memory/prefetch.js'
import {
  checkWritePermission,
  createFilesystemPermissionContext,
} from '../utils/permissions/filesystem.js'
import { setCwd } from '../utils/workspace/cwd.js'
import { runWithRequestScope } from '../utils/workspace/request-scope.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-'))
const home = path.join(tmpRoot, 'home')
const cwd = path.join(tmpRoot, 'proj')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(cwd, { recursive: true })

const prevAuth = process.env.AUTH_ENABLED
process.env.AUTH_ENABLED = 'true'

try {
  await runWithRequestScope({ agentHome: home, cwd }, async () => {
    setCwd(cwd)

    // ── sanitize / parse ──
    assert(
      sanitizeAgentTypeForPath('my-plugin:reviewer') === 'my-plugin-reviewer',
      'sanitize colon',
    )
    assert(parseAgentMemoryScope('project') === 'project', 'parse project')
    assert(parseAgentMemoryScope('nope') === undefined, 'parse invalid')

    // ── paths ──
    const userDir = getAgentMemoryDir('code-reviewer', 'user', cwd)
    const projectDir = getAgentMemoryDir('code-reviewer', 'project', cwd)
    const localDir = getAgentMemoryDir('code-reviewer', 'local', cwd)
    assert(userDir.includes(`${path.sep}agent-memory${path.sep}`), 'user dir')
    assert(userDir.startsWith(home), 'user dir under test home')
    assert(
      projectDir.includes(
        path.join('.ai-agent', 'agent-memory', 'code-reviewer'),
      ),
      'project dir under .ai-agent',
    )
    assert(localDir.includes('agent-memory-local'), 'local dir name')
    assert(
      isAgentMemoryPath(path.join(projectDir, 'MEMORY.md'), cwd),
      'isAgentMemoryPath project',
    )
    assert(
      isAgentMemoryPath(path.join(userDir, 'x.md'), cwd),
      'isAgentMemoryPath user',
    )
    assert(
      !isAgentMemoryPath(path.join(cwd, 'src', 'a.ts'), cwd),
      'not agent memory',
    )

    // ── frontmatter: short form works for both subagent and primary ──
    const sub = parseAgentFromMarkdown({
      filePath: path.join(cwd, 'agents', 'reviewer.md'),
      baseDir: path.join(cwd, 'agents'),
      source: 'project',
      frontmatter: {
        name: 'code-reviewer',
        description: 'Review PRs',
        memory: 'project',
      },
      body: 'You review code.',
    })
    assert(sub.agent?.memory === 'project', 'subagent memory parsed')

    const primary = parseAgentFromMarkdown({
      filePath: path.join(cwd, 'agents', 'browser.md'),
      baseDir: path.join(cwd, 'agents'),
      source: 'project',
      frontmatter: {
        name: 'browser-primary',
        description: 'Browser primary',
        mode: 'primary',
        memory: 'project',
      },
      body: 'Browser agent.',
    })
    assert(primary.agent?.memory === 'project', 'primary short form sets scope')
    assert(
      primary.agent?.memoryPolicy?.mode === 'private',
      'primary short form is private',
    )

    // ── prompt includes MEMORY.md ──
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      '- [Hook](topic.md) — remember tests\n',
    )
    const prompt = loadAgentMemoryPrompt('code-reviewer', 'project', cwd)
    assert(prompt.includes('Persistent Agent Memory'), 'prompt title')
    assert(prompt.includes(projectDir), 'prompt has mem dir')
    assert(prompt.includes('remember tests'), 'prompt embeds index')
    assert(prompt.includes('project-scope'), 'scope note')
    assert(
      prompt.includes(
        'is always loaded into your conversation context — lines after 200 will be truncated',
      ),
      'truncation wording',
    )
    assert(
      prompt.includes('AGENTS.md files'),
      'AGENTS.md exclusion (product rename)',
    )
    assert(
      !prompt.includes('## Searching past context'),
      'no Searching section when the gate is off',
    )

    // ── permission carve-out ──
    const ctx = createFilesystemPermissionContext(cwd, {
      mode: 'default',
      extraWriteRoots: [],
    })
    const memFile = path.join(projectDir, 'topic.md')
    assert(
      checkWritePermission(memFile, ctx).behavior === 'allow',
      'write allow agent memory',
    )

    // ── mentions ──
    assert(
      extractAgentMentions('@agent-code-reviewer please').includes(
        'code-reviewer',
      ),
      'unquoted agent mention',
    )
    assert(
      extractAgentMentions('@"code-reviewer (agent)" hi').includes(
        'code-reviewer',
      ),
      'quoted agent mention',
    )
    assert(
      !extractAtMentionedFiles('@"code-reviewer (agent)"').includes(
        'code-reviewer (agent)',
      ),
      'agent format not treated as file',
    )
    assert(
      extractAtMentionedFiles('@src/foo.ts').includes('src/foo.ts'),
      'file mention still works',
    )

    const autoPath = path.join(cwd, '.ai-agent', 'memory')
    const dirs = resolvePrefetchMemoryDirs(
      '@agent-code-reviewer look',
      autoPath,
      [sub.agent!],
      cwd,
      true,
    )
    assert(
      dirs.length === 1 && dirs[0] === projectDir,
      'prefetch switches to agent memdir',
    )
    const dirsDefault = resolvePrefetchMemoryDirs(
      'hello',
      autoPath,
      [sub.agent!],
      cwd,
      true,
    )
    assert(dirsDefault[0] === autoPath, 'no mention → auto mem')

    // ── snapshot initialize ──
    const snapDir = getSnapshotDirForAgent('snap-agent', cwd)
    fs.mkdirSync(snapDir, { recursive: true })
    fs.writeFileSync(
      path.join(snapDir, 'snapshot.json'),
      JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }),
    )
    fs.writeFileSync(path.join(snapDir, 'seed.md'), '# seed\n')
    const check = await checkAgentMemorySnapshot('snap-agent', 'user', cwd)
    assert(check.action === 'initialize', 'snapshot initialize action')
    await initializeFromSnapshot(
      'snap-agent',
      'user',
      cwd,
      check.snapshotTimestamp!,
    )
    const userMem = getAgentMemoryDir('snap-agent', 'user', cwd)
    assert(fs.existsSync(path.join(userMem, 'seed.md')), 'snapshot copied')

    console.log('ok: test-agent-memory')
  })
} finally {
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
