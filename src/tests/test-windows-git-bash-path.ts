/**
 * Git Bash path derivation — `pathWin32.join(git.exe, '..', '..', 'bin', 'bash.exe')`.
 */
import {
  bashExeFromGitExe,
  findGitBashPath,
} from '../core/shell/windows-paths.js'
import { resolveShellCapabilities } from '../core/shell/shell-utils.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function assertEq(got: string, want: string, msg: string): void {
  assert(got === want, `${msg}\n  got:  ${got}\n  want: ${want}`)
}

assertEq(
  bashExeFromGitExe('C:\\Program Files\\Git\\cmd\\git.exe'),
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'Program Files cmd\\git.exe',
)

assertEq(
  bashExeFromGitExe(
    'C:\\Users\\foo\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
  ),
  'C:\\Users\\foo\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
  'AppData Local Programs cmd\\git.exe',
)

assertEq(
  bashExeFromGitExe('C:\\Program Files (x86)\\Git\\cmd\\git.exe'),
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'Program Files (x86) cmd\\git.exe',
)

const windowsWithGit = resolveShellCapabilities(true, true)
assert(windowsWithGit.bash, 'Windows with Git Bash enables Bash')
assert(windowsWithGit.powershell, 'Windows enables PowerShell')
assert(
  windowsWithGit.defaultKind === 'bash',
  'Windows with Git Bash defaults to Bash',
)

const windowsWithoutGit = resolveShellCapabilities(true, false)
assert(!windowsWithoutGit.bash, 'Windows without Git Bash omits Bash')
assert(windowsWithoutGit.powershell, 'Windows without Git Bash keeps PowerShell')
assert(
  windowsWithoutGit.defaultKind === 'powershell',
  'Windows without Git Bash defaults to PowerShell',
)

const unix = resolveShellCapabilities(false, false)
assert(unix.bash, 'Unix enables Bash')
assert(!unix.powershell, 'Unix omits PowerShell')
assert(unix.defaultKind === 'bash', 'Unix defaults to Bash')

if (process.platform === 'win32') {
  const found = findGitBashPath()
  console.log(
    found
      ? `Git Bash: ${found}`
      : 'Git Bash not installed; PowerShell fallback will be used',
  )
}

console.log('windows git-bash path checks passed')
