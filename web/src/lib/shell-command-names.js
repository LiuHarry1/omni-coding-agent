/**
 * Programs a shell line runs, in order ("cd, git, echo") — the shell row's
 * title when the model gave no description.
 */

/** Syntax that precedes the program on the same simple command. */
const LEADING_WORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'time',
  '!',
  '{',
])
/** Simple commands that run no program of their own. */
const NON_COMMANDS = new Set([
  'for',
  'case',
  'select',
  'function',
  'fi',
  'done',
  'esac',
  '}',
])
const SHELL_WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/
const PROGRAM_NAME = /^[A-Za-z_.][\w.+-]*$/
const HEREDOC = /^<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/

/** Index of the newline closing the heredoc that starts after `newlineAt`. */
function skipHeredocBody(command, newlineAt, delimiter) {
  let start = newlineAt + 1
  while (start < command.length) {
    const nl = command.indexOf('\n', start)
    const end = nl === -1 ? command.length : nl
    if (command.slice(start, end).trim() === delimiter) return end
    start = end + 1
  }
  return command.length
}

/** Split on unquoted operators and newlines; drop comments and heredoc bodies. */
function splitSimpleCommands(command) {
  const segments = []
  let buf = ''
  let quote = null
  let heredocs = []
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === '\\' && quote === '"') {
        buf += c + (command[i + 1] ?? '')
        i++
        continue
      }
      if (c === quote) quote = null
      buf += c
      continue
    }
    if (c === '\\') {
      buf += c + (command[i + 1] ?? '')
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      buf += c
      continue
    }
    if (c === '#' && !/\S$/.test(buf)) {
      const nl = command.indexOf('\n', i)
      i = (nl === -1 ? command.length : nl) - 1
      continue
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = HEREDOC.exec(command.slice(i))
      if (m) {
        heredocs.push(m[2])
        i += m[0].length - 1
        continue
      }
    }
    if (c === '\n') {
      segments.push(buf)
      buf = ''
      for (const delimiter of heredocs) {
        i = skipHeredocBody(command, i, delimiter)
      }
      heredocs = []
      continue
    }
    if ('&|;()`'.includes(c)) {
      segments.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  segments.push(buf)
  return segments
}

function programName(segment) {
  const words = segment.match(SHELL_WORD) ?? []
  if (NON_COMMANDS.has(words[0])) return null
  let k = 0
  while (
    k < words.length &&
    (LEADING_WORDS.has(words[k]) || ENV_ASSIGNMENT.test(words[k]))
  ) {
    k++
  }
  const name = words[k]?.replace(/["']/g, '').split(/[\\/]/).pop()
  return name && PROGRAM_NAME.test(name) ? name : null
}

/** @param {string} command @returns {string[]} */
export function shellCommandNames(command) {
  if (typeof command !== 'string') return []
  const names = []
  for (const segment of splitSimpleCommands(command)) {
    const name = programName(segment)
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}
