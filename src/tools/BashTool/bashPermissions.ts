/**
 * Command-level permission for the shell tools, following Claude Code's
 * `tools/BashTool/bashPermissions.ts`.
 *
 * Rules are written `Bash(git status)`, `Bash(npm run:*)`, `Bash(npm run *)`
 * or just `Bash`, in `permissions.deny` / `permissions.ask` /
 * `permissions.allow`. A command line is split into the simple commands it
 * runs and each is judged on its own:
 *
 *   1. a deny rule on any part refuses the whole line
 *   2. an ask rule on any part asks
 *   3. the line runs without asking when every part is allowed by a rule or
 *      only reads, and nothing is written outside the working directories
 *   4. otherwise there is no decision (`passthrough`) and the caller's
 *      permission mode settles it
 *
 * Not carried over from Claude Code: the tree-sitter parser, the classifier,
 * sandbox auto-allow, and the per-command knowledge of which arguments are
 * paths. In its place, a read-only command runs unasked only when none of its
 * words points outside the directories the session may read.
 */
import * as os from 'os'
import * as path from 'path'
import { isPathInWorkspace } from '../../utils/workspace/workspace.js'
import {
  splitCommand,
  tokenizeCommand,
  type Redirection,
} from '../../utils/bash/commands.js'
import {
  getPathsForPermissionCheck,
  workingDirectories,
  type FilesystemPermissionContext,
} from '../../utils/permissions/filesystem.js'
import { parsePermissionRule } from '../../utils/permissions/permission-rules.js'
import {
  matchWildcardPattern,
  parseShellPermissionRule,
} from '../../utils/permissions/shellRuleMatching.js'
import { containsVulnerableUncPath } from '../../utils/shell/readOnlyCommandValidation.js'
import { isCommandReadOnly } from './readOnlyValidation.js'

export type ShellPermissionResult =
  | { behavior: 'allow'; reason: 'rule' | 'readOnly' }
  | { behavior: 'deny'; message: string; rule: string }
  | { behavior: 'ask'; message: string; rule: string }
  | {
      /** No rule decided. `suggestions` are the rules "Always allow" would add. */
      behavior: 'passthrough'
      message: string
      suggestions: string[]
    }

/** Claude Code: MAX_SUBCOMMANDS_FOR_SECURITY_CHECK. */
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50
/** Claude Code: MAX_SUGGESTED_RULES_FOR_COMPOUND. */
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

/**
 * Whitelist of environment variables that are safe to strip from commands.
 * These variables CANNOT execute code or load libraries.
 *
 * SECURITY: These must NEVER be added to the whitelist:
 * - PATH, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_* (execution/library loading)
 * - PYTHONPATH, NODE_PATH, CLASSPATH, RUBYLIB (module loading)
 * - GOFLAGS, RUSTFLAGS, NODE_OPTIONS (can contain code execution flags)
 * - HOME, TMPDIR, SHELL, BASH_ENV (affect system behavior)
 */
const SAFE_ENV_VARS = new Set([
  // Go - build/runtime settings only
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  // Rust - logging/debugging only
  'RUST_BACKTRACE',
  'RUST_LOG',
  // Node - environment name only (not NODE_OPTIONS!)
  'NODE_ENV',
  // Python - behavior flags only (not PYTHONPATH!)
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  // Pytest - test configuration
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  // Locale and character encoding
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  // Terminal and display
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  // Color configuration for various tools
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  // Display formatting
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
])

// Bare-prefix suggestions like `bash:*` or `sh:*` would allow arbitrary code
// via `-c`. Wrapper suggestions like `env:*` or `sudo:*` would do the same.
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // wrappers that exec their args as a command
  'env',
  'xargs',
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // privilege escalation
  'sudo',
  'doas',
  'pkexec',
])

/**
 * Extract a stable command prefix (command + subcommand) from a raw command
 * string. Skips leading env var assignments only if they are in
 * SAFE_ENV_VARS; any other assignment returns null so the caller falls back
 * to an exact rule (a prefix rule could never match such a command).
 *
 *   'git commit -m "fix typo"'     → 'git commit'
 *   'NODE_ENV=prod npm run build'  → 'npm run'
 *   'MY_VAR=val npm run build'     → null
 *   'ls -la' / 'cat file.txt'      → null (second word is not a subcommand)
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    if (!SAFE_ENV_VARS.has(varName)) return null
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  if (BARE_SHELL_PREFIXES.has(remaining[0]!)) return null
  const subcmd = remaining[1]!
  // Second token must look like a subcommand (e.g., "commit", "run"), not a
  // flag (-rf), filename (file.txt), path (/tmp), URL, or number (755).
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return remaining.slice(0, 2).join(' ')
}

/**
 * Strips env var assignments on the safe list and wrapper commands that just
 * run their arguments (timeout, time, nice, stdbuf, nohup), so that
 * `Bash(npm install:*)` matches `timeout 10 npm install foo`.
 */
export function stripSafeWrappers(command: string): string {
  // SECURITY: Use [ \t]+ not \s+ — \s matches \n/\r which are command
  // separators in bash.
  //
  // SECURITY: `(?:--[ \t]+)?` consumes the wrapper's own `--` so
  // `nohup -- rm -- -/../foo` strips to `rm -- -/../foo`.
  const SAFE_WRAPPER_PATTERNS = [
    // SECURITY: flag VALUES use allowlist [A-Za-z0-9_.+-] (signals are
    // TERM/KILL/9, durations are 5/5s/10.5). `timeout -k$(id) 10 ls` must
    // not strip to `ls`.
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  // SECURITY: Only matches unquoted values with safe characters (no $(), `,
  // $var, ;|&), and only horizontal whitespace after the value.
  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  // Phase 1: leading env vars. `VAR=val cmd` is a shell-level assignment.
  while (stripped !== previousStripped) {
    previousStripped = stripped
    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch && SAFE_ENV_VARS.has(envVarMatch[1]!)) {
      stripped = stripped.replace(ENV_VAR_PATTERN, '')
    }
  }

  // Phase 2: wrapper commands only. A wrapper execs its arguments, so
  // `VAR=val` after it is the command to run, not an assignment.
  previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '')
    }
  }

  return stripped.trim()
}

/**
 * Strip ALL leading env var prefixes, whether or not the name is on the safe
 * list. Used for deny/ask rules: a denied command stays denied when written
 * as `FOO=bar denied_command`.
 */
export function stripAllLeadingEnvVars(command: string): string {
  // $ is excluded from the value classes to block $(cmd), ${var}, $((expr)).
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/

  let stripped = command
  let previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    const m = stripped.match(ENV_VAR_PATTERN)
    if (!m) continue
    stripped = stripped.slice(m[0].length)
  }
  return stripped.trim()
}

type ToolRules = {
  /** A rule with no content: `Bash`. */
  wholeTool: string | null
  /** Rule content → the rule as written in settings. */
  byContent: Map<string, string>
}

function rulesForTool(rules: readonly string[], toolName: string): ToolRules {
  const out: ToolRules = { wholeTool: null, byContent: new Map() }
  for (const ruleString of rules) {
    const rule = parsePermissionRule(ruleString)
    if (rule.toolName !== toolName) continue
    if (rule.ruleContent === undefined) out.wholeTool ??= ruleString
    else out.byContent.set(rule.ruleContent, ruleString)
  }
  return out
}

function candidatesFor(command: string, stripAllEnvVars: boolean): string[] {
  const trimmed = command.trim()
  const stripped = stripSafeWrappers(trimmed)
  const candidates = stripped !== trimmed ? [trimmed, stripped] : [trimmed]
  if (!stripAllEnvVars) return candidates

  // Apply both strippers until nothing new appears, so interleavings such as
  // `nohup FOO=bar timeout 5 denied` are unwrapped all the way.
  const seen = new Set(candidates)
  for (let i = 0; i < candidates.length; i++) {
    for (const next of [
      stripAllLeadingEnvVars(candidates[i]!),
      stripSafeWrappers(candidates[i]!),
    ]) {
      if (!seen.has(next)) {
        seen.add(next)
        candidates.push(next)
      }
    }
  }
  return candidates
}

/**
 * The first rule whose content matches the command.
 *
 * `exact` mode is for the whole command line as typed: only exact rules
 * match, since a prefix or wildcard would also swallow `&& something else`.
 * `prefix` mode is for one already-split simple command.
 */
function matchingRule(
  command: string,
  rules: ToolRules,
  matchMode: 'exact' | 'prefix',
  options: { stripAllEnvVars?: boolean } = {},
): string | null {
  if (rules.byContent.size === 0) return null
  const candidates = candidatesFor(command, options.stripAllEnvVars ?? false)

  for (const [content, ruleString] of rules.byContent) {
    const rule = parseShellPermissionRule(content)
    const matched = candidates.some(candidate => {
      switch (rule.type) {
        case 'exact':
          return rule.command === candidate
        case 'prefix': {
          if (matchMode === 'exact') return rule.prefix === candidate
          // Word boundary: `ls:*` must not match `lsof`.
          if (candidate === rule.prefix) return true
          if (candidate.startsWith(rule.prefix + ' ')) return true
          // Bare xargs: `Bash(rm:*)` also covers `xargs rm file`.
          const xargsPrefix = 'xargs ' + rule.prefix
          return (
            candidate === xargsPrefix || candidate.startsWith(xargsPrefix + ' ')
          )
        }
        case 'wildcard':
          if (matchMode === 'exact') return false
          return matchWildcardPattern(rule.pattern, candidate)
      }
    })
    if (matched) return ruleString
  }
  return null
}

function denyMessage(toolName: string, command: string): string {
  return `Permission to use ${toolName} with command ${command} has been denied.`
}

function askMessage(command: string): string {
  return `Permission needed to run: ${command}`
}

function expandHome(target: string): string {
  if (target === '~') return os.homedir()
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2))
  return target
}

function isInside(target: string, cwd: string, roots: string[]): boolean {
  const abs = path.resolve(cwd, expandHome(target))
  return getPathsForPermissionCheck(abs).every(candidate =>
    roots.some(root => isPathInWorkspace(candidate, root)),
  )
}

/** A redirection whose file is not known, or lies outside the given roots. */
function redirectsOutside(
  redirection: Redirection,
  cwd: string,
  ctx: FilesystemPermissionContext,
): boolean {
  if (!redirection.isStatic) return true
  const roots =
    redirection.direction === 'output'
      ? [...workingDirectories(ctx), ...ctx.extraWriteRoots]
      : [...workingDirectories(ctx), ...ctx.extraReadRoots]
  return !isInside(redirection.target, cwd, roots)
}

const LEAVES_DIRECTORY = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/**
 * Whether a word of a read-only command names a place outside the readable
 * directories: an absolute path, a home path, or one that climbs with `..`.
 * A word that merely looks like one (a regex starting with `/`) counts too;
 * the cost is a prompt.
 */
function readsOutside(
  subcommand: string,
  cwd: string,
  ctx: FilesystemPermissionContext,
): boolean {
  const words = tokenizeCommand(subcommand)
  if (!words) return true
  const roots = [...workingDirectories(ctx), ...ctx.extraReadRoots]
  return words.slice(1).some(word => {
    let candidate = word
    if (candidate.startsWith('-')) {
      const equals = candidate.indexOf('=')
      if (equals === -1) return false
      candidate = candidate.slice(equals + 1)
    }
    const pointsAway =
      path.isAbsolute(candidate) ||
      candidate.startsWith('~') ||
      LEAVES_DIRECTORY.test(candidate)
    return pointsAway && !isInside(candidate, cwd, roots)
  })
}

const GIT_COMMAND = /^git(?:\s|$)/
const CD_COMMAND = /^cd(?:\s|$)/

/** Inverse of the unescaping done when a `Tool(content)` rule is read. */
function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function suggestRules(toolName: string, subcommands: string[]): string[] {
  const rules = new Set<string>()
  for (const subcommand of subcommands) {
    const prefix = getSimpleCommandPrefix(subcommand)
    const content = prefix ? `${prefix}:*` : subcommand
    if (content.includes('\n')) return []
    rules.add(`${toolName}(${escapeRuleContent(content)})`)
  }
  if (rules.size > MAX_SUGGESTED_RULES_FOR_COMPOUND) return []
  return [...rules]
}

export function checkShellCommandPermission(
  toolName: string,
  rawCommand: string,
  cwd: string,
  ctx: FilesystemPermissionContext,
): ShellPermissionResult {
  const command = rawCommand.trim()
  const deny = rulesForTool(ctx.deny, toolName)
  const ask = rulesForTool(ctx.ask, toolName)
  const allow = rulesForTool(ctx.allow, toolName)

  if (deny.wholeTool) {
    return {
      behavior: 'deny',
      message: `Permission to use ${toolName} has been denied.`,
      rule: deny.wholeTool,
    }
  }

  // The whole line exactly as a rule names it.
  const exactDeny = matchingRule(command, deny, 'exact', {
    stripAllEnvVars: true,
  })
  if (exactDeny) {
    return {
      behavior: 'deny',
      message: denyMessage(toolName, command),
      rule: exactDeny,
    }
  }

  const parsed = splitCommand(command)
  const subcommands = parsed.subcommands

  // Deny and ask rules look at every part, so a refused command cannot ride
  // along inside `ok && refused`.
  for (const subcommand of subcommands) {
    const rule = matchingRule(subcommand, deny, 'prefix', {
      stripAllEnvVars: true,
    })
    if (rule) {
      return {
        behavior: 'deny',
        message: denyMessage(toolName, command),
        rule,
      }
    }
  }

  if (ask.wholeTool) {
    return {
      behavior: 'ask',
      message: askMessage(command),
      rule: ask.wholeTool,
    }
  }
  const askRule =
    matchingRule(command, ask, 'exact', { stripAllEnvVars: true }) ??
    subcommands
      .map(subcommand =>
        matchingRule(subcommand, ask, 'prefix', { stripAllEnvVars: true }),
      )
      .find(rule => rule !== null)
  if (askRule) {
    return { behavior: 'ask', message: askMessage(command), rule: askRule }
  }

  if (allow.wholeTool || matchingRule(command, allow, 'exact')) {
    return { behavior: 'allow', reason: 'rule' }
  }

  const passthrough = (suggestions: string[]): ShellPermissionResult => ({
    behavior: 'passthrough',
    message: askMessage(command),
    suggestions,
  })

  // From here on the line has to be understood completely to run unasked.
  if (
    !parsed.simple ||
    subcommands.length === 0 ||
    subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK ||
    containsVulnerableUncPath(command)
  ) {
    return passthrough([])
  }

  const unapproved: string[] = []
  let allowedByRule = false
  subcommands.forEach((subcommand, index) => {
    if (matchingRule(subcommand, allow, 'prefix')) {
      allowedByRule = true
      return
    }
    // Only reading, from inside the readable directories, into no file.
    const redirected = parsed.redirections.some(r => r.commandIndex === index)
    if (
      !redirected &&
      isCommandReadOnly(subcommand) &&
      !readsOutside(subcommand, cwd, ctx)
    ) {
      return
    }
    unapproved.push(subcommand)
  })
  if (unapproved.length > 0) {
    return passthrough(suggestRules(toolName, unapproved))
  }

  // A rule approves the command, not where its output goes.
  if (parsed.redirections.some(r => redirectsOutside(r, cwd, ctx))) {
    return passthrough([])
  }
  // `cd elsewhere && git ...` runs git, and that directory's hooks and
  // config, somewhere nobody approved.
  if (
    subcommands.some(sub => CD_COMMAND.test(sub)) &&
    subcommands.some(sub => GIT_COMMAND.test(stripSafeWrappers(sub)))
  ) {
    return passthrough([])
  }

  return { behavior: 'allow', reason: allowedByRule ? 'rule' : 'readOnly' }
}
