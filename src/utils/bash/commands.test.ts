import { describe, expect, it } from 'vitest'
import { splitCommand, tokenizeCommand } from './commands.js'

describe('splitCommand', () => {
  it('splits on every operator that starts another command', () => {
    expect(
      splitCommand('cd src && npm test || echo failed; ls | wc -l & pwd')
        .subcommands,
    ).toEqual(['cd src', 'npm test', 'echo failed', 'ls', 'wc -l', 'pwd'])
  })

  it('treats a newline as a separator and drops comments', () => {
    const parsed = splitCommand('# list files\nls -la # trailing\npwd')
    expect(parsed.subcommands).toEqual(['ls -la', 'pwd'])
    expect(parsed.simple).toBe(true)
  })

  it('leaves operators inside quotes alone', () => {
    const parsed = splitCommand(`echo "a && b; c" 'd | e' f\\;g`)
    expect(parsed.subcommands).toEqual([`echo "a && b; c" 'd | e' f\\;g`])
    expect(parsed.simple).toBe(true)
  })

  it('joins a continued line', () => {
    expect(splitCommand('npm run \\\nbuild').subcommands).toEqual([
      'npm run build',
    ])
  })

  it('takes file redirections out of the command and reports them', () => {
    const parsed = splitCommand('npm run build > "out dir/log.txt" 2>&1')
    expect(parsed.subcommands).toEqual(['npm run build'])
    expect(parsed.redirections).toEqual([
      {
        operator: '>',
        target: 'out dir/log.txt',
        isStatic: true,
        direction: 'output',
        commandIndex: 0,
      },
    ])
  })

  it('ties each redirection to its own command', () => {
    const parsed = splitCommand('cat < in.txt | sort >> out.txt')
    expect(parsed.redirections.map(r => [r.direction, r.commandIndex])).toEqual(
      [
        ['input', 0],
        ['output', 1],
      ],
    )
  })

  it('ignores descriptor copies and /dev/null', () => {
    const parsed = splitCommand('make 2>&1 >/dev/null 2>/dev/null >&2')
    expect(parsed.subcommands).toEqual(['make'])
    expect(parsed.redirections).toEqual([])
    expect(parsed.simple).toBe(true)
  })

  it('marks a target that depends on expansion', () => {
    expect(splitCommand('echo hi > $HOME/x').redirections[0]?.isStatic).toBe(
      false,
    )
  })

  it.each([
    ['command substitution', 'echo $(whoami)'],
    ['backticks', 'echo `whoami`'],
    ['substitution inside double quotes', 'echo "today is $(date)"'],
    ['parameter expansion', 'echo ${HOME}'],
    ['process substitution', 'diff <(ls a) <(ls b)'],
    ['a subshell', '(cd src && ls)'],
    ['a heredoc', 'cat <<EOF\nrm -rf x\nEOF'],
    ['a here-string', 'cat <<< "text"'],
    ['an open quote', 'echo "unfinished'],
    ['ANSI-C quoting', "echo $'\\x72\\x6d'"],
    ['a loop', 'for f in a b; do rm $f; done'],
    ['a condition', 'if true; then rm x; fi'],
    ['a bare redirection', '> important.txt'],
  ])('does not call a line with %s simple', (_what, command) => {
    expect(splitCommand(command).simple).toBe(false)
  })

  it('still shows the command that follows a keyword', () => {
    const parsed = splitCommand('if true; then rm -rf x; fi')
    expect(parsed.subcommands).toContain('rm -rf x')
  })
})

describe('tokenizeCommand', () => {
  it('removes quotes and keeps a quoted word whole', () => {
    expect(tokenizeCommand(`git log --format="%h %s" 'a b' c\\ d`)).toEqual([
      'git',
      'log',
      '--format=%h %s',
      'a b',
      'c d',
    ])
  })

  it('keeps a variable as written', () => {
    expect(tokenizeCommand('git diff "$Z--output=/tmp/x"')).toEqual([
      'git',
      'diff',
      '$Z--output=/tmp/x',
    ])
  })

  it('refuses anything more than a list of words', () => {
    expect(tokenizeCommand('ls | wc')).toBeNull()
    expect(tokenizeCommand('ls > out')).toBeNull()
    expect(tokenizeCommand('echo $(id)')).toBeNull()
    expect(tokenizeCommand('echo "open')).toBeNull()
  })
})
