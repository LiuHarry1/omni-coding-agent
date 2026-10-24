/**
 * Run: npx vitest run web/src/lib/shell-command-names.test.js
 */
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { shellCommandNames } from './shell-command-names.js'

describe('shellCommandNames', () => {
  it('lists each program once, in order', () => {
    assert.deepEqual(
      shellCommandNames(
        'cd /repo && ls -a && cat package.json pyproject.toml 2>/dev/null | head -80 && git ls-files | head -150',
      ),
      ['cd', 'ls', 'cat', 'head', 'git'],
    )
    assert.deepEqual(
      shellCommandNames(
        'cd /repo && cat start.js | head -60; ls src src/* -d; ls web/src',
      ),
      ['cd', 'cat', 'head', 'ls'],
    )
  })

  it('ignores operators inside quotes', () => {
    assert.deepEqual(
      shellCommandNames(`echo "a && b; c | d" && git commit -m 'x; y'`),
      ['echo', 'git'],
    )
  })

  it('skips env assignments and directories', () => {
    assert.deepEqual(
      shellCommandNames('NODE_ENV=test ./node_modules/.bin/vitest run'),
      ['vitest'],
    )
    assert.deepEqual(
      shellCommandNames('& "C:\\Program Files\\Git\\bin\\git.exe" status'),
      ['git.exe'],
    )
  })

  it('drops heredoc bodies and comments', () => {
    assert.deepEqual(
      shellCommandNames(
        "# notes first\ncat <<'EOF' > notes.md\nrm -rf build\nEOF\ngit add notes.md",
      ),
      ['cat', 'git'],
    )
  })

  it('looks past shell keywords', () => {
    assert.deepEqual(shellCommandNames('for f in *.ts; do wc -l "$f"; done'), [
      'wc',
    ])
    assert.deepEqual(
      shellCommandNames('if grep -q x a.txt; then echo yes; fi'),
      ['grep', 'echo'],
    )
  })

  it('reaches into substitutions but not redirections', () => {
    assert.deepEqual(shellCommandNames('echo $(git rev-parse HEAD)'), [
      'echo',
      'git',
    ])
    assert.deepEqual(shellCommandNames('npm test 2>&1 | tail -20'), [
      'npm',
      'tail',
    ])
  })

  it('handles PowerShell pipelines', () => {
    assert.deepEqual(
      shellCommandNames('Get-ChildItem -Recurse | Select-Object -First 5'),
      ['Get-ChildItem', 'Select-Object'],
    )
  })

  it('returns nothing it cannot name', () => {
    assert.deepEqual(shellCommandNames('$CMD --flag'), [])
    assert.deepEqual(shellCommandNames(''), [])
    assert.deepEqual(shellCommandNames(undefined), [])
  })
})
