/**
 * Unit checks for tools/utils resolvePath (Windows abs / join antipattern).
 */
import * as path from 'path'
import { normalizeWorkspacePath } from '../utils/workspace/path.js'
import {
  isWindowsAbsolute,
  resolvePath,
  unwrapJoinedWindowsAbsolute,
} from '../tools/utils.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const cwd = 'C:\\Users\\harry.liu\\cursor_workspace\\ai_coding_agent_intro'
const mem =
  'C:\\Users\\harry.liu\\.ai-agent\\projects\\C--Users-harry-liu-cursor-workspace-ai-coding-agent-intro\\memory\\reference_concur_login.md'

assert(isWindowsAbsolute(mem), 'mem is windows absolute')
assert(isWindowsAbsolute('C:/Users/x'), 'forward-slash drive abs')
assert(!isWindowsAbsolute('memory/file.md'), 'relative not abs')

{
  const joined = path.join(cwd, mem)
  assert(
    joined.includes(cwd) && joined.includes('.ai-agent'),
    'path.join still concatenates abs on this Node',
  )
  const fixed = unwrapJoinedWindowsAbsolute(cwd, joined)
  assert(fixed !== null, 'unwrap detects join antipattern')
  assert(
    path.normalize(fixed!).toLowerCase() === path.normalize(mem).toLowerCase(),
    'unwrap recovers memory path',
  )
}

{
  const r = resolvePath(cwd, mem)
  assert('abs' in r && r.abs, 'resolve abs mem')
  assert(
    path.normalize(r.abs!).toLowerCase() === path.normalize(mem).toLowerCase(),
    'absolute memory path not joined onto cwd',
  )
}

{
  const joined = path.join(cwd, mem)
  const r = resolvePath(cwd, joined)
  assert('abs' in r && r.abs, 'resolve joined antipattern')
  assert(
    path.normalize(r.abs!).toLowerCase() === path.normalize(mem).toLowerCase(),
    'joined antipattern repaired',
  )
}

{
  const r = resolvePath(cwd, 'memory/reference_concur_login.md')
  assert('abs' in r && r.abs, 'relative ok')
  assert(
    r.abs!.toLowerCase() ===
      path.resolve(cwd, 'memory/reference_concur_login.md').toLowerCase(),
    'relative resolves under cwd',
  )
}

{
  const r = resolvePath(cwd, '~/Documents/x.md')
  assert('abs' in r && r.abs, 'tilde expands')
  assert(r.abs!.includes('Documents'), 'tilde home')
}

if (process.platform === 'win32') {
  const local = process.cwd()
  const n = normalizeWorkspacePath(local)
  assert(
    n.replace(/\//g, '\\').toLowerCase() === path.resolve(local).toLowerCase(),
    `C:\\Users\\... must stay a Windows path, got ${n}`,
  )
}

console.log('resolvePath tests OK')
