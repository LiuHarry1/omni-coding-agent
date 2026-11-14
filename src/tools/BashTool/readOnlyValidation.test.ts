import { describe, expect, it } from 'vitest'
import {
  isBashCommandReadOnly,
  isCommandReadOnly,
} from './readOnlyValidation.js'

describe('isBashCommandReadOnly', () => {
  it.each([
    'git status',
    'git diff --stat HEAD~1',
    'git log --oneline -5',
    'ls -la src',
    'cat package.json',
    'pwd',
    'grep -rn "foo" src',
    'rg -n foo src | wc -l',
    'find . -name "*.ts"',
    'cat a.txt | sort -u | head -20',
    'git log --oneline 2>&1 | head',
    'echo "done"',
  ])('accepts %s', command => {
    expect(isBashCommandReadOnly(command)).toBe(true)
  })

  it.each([
    ['an unknown command', 'npm test'],
    ['a mutating git command', 'git commit -m x'],
    ['one mutating part', 'git status && rm -rf build'],
    ['output to a file', 'cat a.txt > b.txt'],
    ['a flag that writes', 'git diff --output=/tmp/x'],
    ['a flag that runs a program', 'rg --pre=bash foo'],
    ['find that deletes', 'find . -name "*.log" -delete'],
    ['find that executes', 'find . -exec rm {} \\;'],
    ['git config injection', 'git -c core.pager=evil log'],
    ['a variable', 'cat $FILE'],
    ['a glob', 'cat *.env'],
    ['command substitution', 'echo $(rm x)'],
    ['a heredoc', 'cat <<EOF\nhi\nEOF'],
    ['cd before git', 'cd /tmp/repo && git status'],
    ['sed', 'sed -n 1,5p a.txt'],
    ['an empty command', '   '],
  ])('refuses %s', (_what, command) => {
    expect(isBashCommandReadOnly(command)).toBe(false)
  })
})

describe('isCommandReadOnly', () => {
  it('reads past a trailing 2>&1', () => {
    expect(isCommandReadOnly('git status 2>&1')).toBe(true)
  })

  it('does not accept a longer word that starts with a safe command', () => {
    expect(isCommandReadOnly('cat file')).toBe(true)
    expect(isCommandReadOnly('catfish file')).toBe(false)
  })
})
