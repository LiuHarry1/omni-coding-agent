/**
 * Persistent per-subagent memory.
 * Paths live under `.ai-agent`; user scope under agent home.
 * Prompt text comes from `buildMemoryPrompt` with no local additions.
 */
import * as fs from 'fs'
import { join, normalize, sep } from 'path'
import { getAgentHome } from '../../utils/workspace/request-scope.js'
import { getAppDirName } from '../../utils/app-dir.js'
import { getCwd } from '../../utils/workspace/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git-root.js'
import { sanitizePath } from '../../utils/sanitize-path.js'
import { AUTO_MEM_ENTRYPOINT } from '../../services/auto-memory/paths.js'
import { buildMemoryPrompt } from '../../services/auto-memory/prompts.js'
import type { AgentMemoryScope, MemoryVocabulary } from '../../core/types.js'

export type { AgentMemoryScope }
export { parseAgentMemoryScope } from './memoryPolicy.js'

const AGENT_MEMORY_DIRNAME = 'agent-memory'
const AGENT_MEMORY_LOCAL_DIRNAME = 'agent-memory-local'

/** Replace colons (plugin-scoped types) for filesystem-safe directory names. */
export function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  }
  return join(getAgentHome(), getAppDirName())
}

function getLocalAgentMemoryDir(dirName: string, cwd?: string): string {
  const root = cwd ?? getCwd()
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(findCanonicalGitRoot(root) ?? root),
        AGENT_MEMORY_LOCAL_DIRNAME,
        dirName,
      ) + sep
    )
  }
  return join(root, getAppDirName(), AGENT_MEMORY_LOCAL_DIRNAME, dirName) + sep
}

/**
 * Agent memory directory for a type + scope.
 * - user: `{agentHome}/.ai-agent/agent-memory/<type>/`
 * - project: `{cwd}/.ai-agent/agent-memory/<type>/`
 * - local: `{cwd}/.ai-agent/agent-memory-local/<type>/` (or remote mount)
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  cwd?: string,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  const root = cwd ?? getCwd()
  switch (scope) {
    case 'project':
      return join(root, getAppDirName(), AGENT_MEMORY_DIRNAME, dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName, root)
    case 'user':
      return join(getMemoryBaseDir(), AGENT_MEMORY_DIRNAME, dirName) + sep
  }
}

/** True if path is under any agent-memory scope directory. */
export function isAgentMemoryPath(absolutePath: string, cwd?: string): boolean {
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()
  const root = cwd ?? getCwd()
  const app = getAppDirName()

  if (normalizedPath.startsWith(join(memoryBase, AGENT_MEMORY_DIRNAME) + sep)) {
    return true
  }

  if (normalizedPath.startsWith(join(root, app, AGENT_MEMORY_DIRNAME) + sep)) {
    return true
  }

  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + AGENT_MEMORY_LOCAL_DIRNAME + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(join(root, app, AGENT_MEMORY_LOCAL_DIRNAME) + sep)
  ) {
    return true
  }

  return false
}

export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
  cwd?: string,
): string {
  return join(getAgentMemoryDir(agentType, scope, cwd), AUTO_MEM_ENTRYPOINT)
}

export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(getMemoryBaseDir(), AGENT_MEMORY_DIRNAME)}/)`
    case 'project':
      return `Project (${getAppDirName()}/agent-memory/)`
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      return 'None'
  }
}

export function agentMemoryScopeNote(scope: AgentMemoryScope): string {
  switch (scope) {
    case 'user':
      return '- Since this memory is user-scope, keep learnings general since they apply across all projects'
    case 'project':
      return '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
    case 'local':
      return '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
  }
}

export function ensureAgentMemoryDirExists(memoryDir: string): void {
  try {
    fs.mkdirSync(memoryDir, { recursive: true })
  } catch {
    // Prompt building continues; Write tool mkdir parent on write.
  }
}

/**
 * Load persistent memory for an agent with memory enabled.
 * Creates the memory directory if needed and returns a prompt with memory contents.
 * Prompt body is `buildMemoryPrompt` (scope notes only as extraGuidelines).
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
  cwd?: string,
  vocabulary: MemoryVocabulary = 'coding',
): string {
  const scopeNote = agentMemoryScopeNote(scope)

  const memoryDir = getAgentMemoryDir(agentType, scope, cwd)
  ensureAgentMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    vocabulary,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}
