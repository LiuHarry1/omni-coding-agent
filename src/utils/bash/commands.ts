/**
 * Splits a bash command line into the simple commands it runs.
 *
 * This does the job of Claude Code's `splitCommand` (`utils/bash/commands.ts`)
 * for permission checks: `cd src && npm test | tee out.log` is three commands
 * and one file redirection, and each command is judged on its own.
 *
 * It is a lexer, not a shell. Whatever it does not follow — command and
 * process substitution, `${...}`, subshells, heredocs, control flow, an
 * unterminated quote — makes the result `simple: false`. Callers treat such a
 * line as something that cannot be approved automatically, while still
 * checking the pieces that were found against deny rules.
 */

export type Redirection = {
  operator: string
  /** Target with quotes removed. */
  target: string
  /** False when the target depends on expansion (`$VAR`, globs, braces). */
  isStatic: boolean
  direction: 'input' | 'output'
  /** Index into `subcommands` of the command this redirection belongs to. */
  commandIndex: number
}

export type ParsedCommand = {
  simple: boolean
  /** Each simple command, redirections removed, words joined by one space. */
  subcommands: string[]
  /** File redirections. Descriptor copies (`2>&1`) and `/dev/null` are left out. */
  redirections: Redirection[]
}

type Word = { type: 'word'; raw: string; value: string }
type Operator = { type: 'op'; op: string }
type Token = Word | Operator

type LexResult = { tokens: Token[]; simple: boolean }

const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n'])
const REDIRECT_OPERATORS = new Set([
  '>',
  '>>',
  '>|',
  '>&',
  '&>',
  '&>>',
  '<',
  '<&',
  '<>',
])

/** Words that start a compound construct rather than a command. */
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'coproc',
  '!',
  '{',
  '}',
  '[[',
])

/** Keywords that are followed by a command on the same line. */
const KEYWORD_PREFIXES = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
])

const EXPANSION_IN_TARGET = /[$`*?[\]{}]/

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r'
}

function lex(command: string): LexResult {
  const tokens: Token[] = []
  let simple = true
  let raw = ''
  let value = ''
  let inWord = false
  let i = 0

  const endWord = () => {
    if (!inWord) return
    tokens.push({ type: 'word', raw, value })
    raw = ''
    value = ''
    inWord = false
  }
  const pushOp = (op: string, length: number) => {
    endWord()
    tokens.push({ type: 'op', op })
    i += length
  }

  while (i < command.length) {
    const char = command[i]!
    const next = command[i + 1]

    if (isWhitespace(char)) {
      endWord()
      i++
      continue
    }

    if (char === '\n') {
      pushOp('\n', 1)
      continue
    }

    if (char === '\\') {
      if (next === undefined) {
        simple = false
        i++
        continue
      }
      if (next === '\n') {
        // Line continuation: the pair disappears.
        i += 2
        continue
      }
      inWord = true
      raw += char + next
      value += next
      i += 2
      continue
    }

    if (char === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) {
        simple = false
        inWord = true
        raw += command.slice(i)
        value += command.slice(i + 1)
        i = command.length
        continue
      }
      inWord = true
      raw += command.slice(i, close + 1)
      value += command.slice(i + 1, close)
      i = close + 1
      continue
    }

    if (char === '"') {
      inWord = true
      raw += char
      i++
      let closed = false
      while (i < command.length) {
        const c = command[i]!
        const n = command[i + 1]
        if (c === '\\' && n !== undefined) {
          raw += c + n
          value += '$`"\\\n'.includes(n) ? (n === '\n' ? '' : n) : c + n
          i += 2
          continue
        }
        if (c === '"') {
          raw += c
          i++
          closed = true
          break
        }
        // Substitution still runs inside double quotes.
        if (c === '`' || (c === '$' && (n === '(' || n === '{'))) {
          simple = false
        }
        raw += c
        value += c
        i++
      }
      if (!closed) simple = false
      continue
    }

    if (char === '`') {
      simple = false
      inWord = true
      raw += char
      value += char
      i++
      continue
    }

    if (char === '$') {
      // $(...), ${...} and $'...' can each produce arbitrary text.
      if (next === '(' || next === '{' || next === "'" || next === '"') {
        simple = false
      }
      inWord = true
      raw += char
      value += char
      i++
      continue
    }

    if (char === '(' || char === ')') {
      // Subshell, process substitution, function definition, array.
      simple = false
      pushOp(char, 1)
      continue
    }

    if (char === '#' && !inWord) {
      const lineEnd = command.indexOf('\n', i)
      i = lineEnd === -1 ? command.length : lineEnd
      continue
    }

    if (char === ';') {
      if (next === ';') {
        simple = false
        pushOp(';', 2)
      } else {
        pushOp(';', 1)
      }
      continue
    }

    if (char === '&') {
      if (next === '&') pushOp('&&', 2)
      else if (next === '>') {
        pushOp(
          command[i + 2] === '>' ? '&>>' : '&>',
          command[i + 2] === '>' ? 3 : 2,
        )
      } else pushOp('&', 1)
      continue
    }

    if (char === '|') {
      if (next === '|') pushOp('||', 2)
      else if (next === '&') pushOp('|&', 2)
      else pushOp('|', 1)
      continue
    }

    if (char === '>' || char === '<') {
      // A descriptor number directly before the operator belongs to it.
      if (inWord && /^\d+$/.test(raw)) {
        raw = ''
        value = ''
        inWord = false
      }
      if (char === '>') {
        if (next === '>') pushOp('>>', 2)
        else if (next === '&') pushOp('>&', 2)
        else if (next === '|') pushOp('>|', 2)
        else if (next === '(') {
          simple = false
          pushOp('>', 1)
        } else pushOp('>', 1)
      } else {
        if (next === '<') {
          // Heredoc or here-string: the body is not a command to judge.
          simple = false
          pushOp('<<', command[i + 2] === '<' ? 3 : 2)
        } else if (next === '&') pushOp('<&', 2)
        else if (next === '>') pushOp('<>', 2)
        else if (next === '(') {
          simple = false
          pushOp('<', 1)
        } else pushOp('<', 1)
      }
      continue
    }

    inWord = true
    raw += char
    value += char
    i++
  }
  endWord()

  return { tokens, simple }
}

export function splitCommand(command: string): ParsedCommand {
  const { tokens, simple: lexedSimple } = lex(command)
  let simple = lexedSimple
  const subcommands: string[] = []
  const redirections: Redirection[] = []
  let words: Word[] = []
  let redirected = false

  const endCommand = () => {
    while (words.length > 0 && KEYWORD_PREFIXES.has(words[0]!.raw)) {
      // `then rm -rf x` still runs rm; keep the command visible to rules.
      simple = false
      words = words.slice(1)
    }
    if (words.length > 0) {
      if (SHELL_KEYWORDS.has(words[0]!.raw)) simple = false
      subcommands.push(words.map(word => word.raw).join(' '))
    } else if (redirected) {
      // `> file` on its own still truncates the file.
      simple = false
    }
    words = []
    redirected = false
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === 'word') {
      words.push(token)
      continue
    }

    if (SEPARATORS.has(token.op)) {
      endCommand()
      continue
    }

    if (REDIRECT_OPERATORS.has(token.op)) {
      const target = tokens[i + 1]
      if (!target || target.type !== 'word') {
        simple = false
        continue
      }
      i++
      const copiesDescriptor =
        (token.op === '>&' || token.op === '<&') &&
        /^(?:\d+|-)$/.test(target.value)
      if (copiesDescriptor || target.value === '/dev/null') continue
      redirected = true
      redirections.push({
        operator: token.op,
        target: target.value,
        isStatic: !EXPANSION_IN_TARGET.test(target.raw),
        direction: token.op === '<' ? 'input' : 'output',
        commandIndex: subcommands.length,
      })
      continue
    }

    // Parentheses and heredoc markers were already counted as not simple.
  }
  endCommand()

  return { simple, subcommands, redirections }
}

/**
 * Words of one simple command with quotes removed, or null when the text is
 * anything more than a plain word list (operators, redirections,
 * substitution, an open quote). `$VAR` is left in the word as written.
 */
export function tokenizeCommand(command: string): string[] | null {
  const { tokens, simple } = lex(command)
  if (!simple) return null
  const words: string[] = []
  for (const token of tokens) {
    if (token.type !== 'word') return null
    words.push(token.value)
  }
  return words
}
