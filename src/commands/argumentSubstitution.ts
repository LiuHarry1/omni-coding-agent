/**
 * Argument substitution for slash commands.
 *
 * Supported placeholders inside a command body:
 *
 *   $ARGUMENTS         the entire post-`/cmd ` string, verbatim
 *   $ARGUMENTS[0..N]   indexed access into the parsed argument array
 *   $0, $1, …          shorthand for $ARGUMENTS[0..N]
 *   $name              named arg (when `arguments:` frontmatter declares names)
 *
 * Args are tokenized with simple shell-style quoting (single + double
 * quotes preserve spaces). We don't pull in `shell-quote` to keep the
 * dependency footprint small — slash commands rarely need full POSIX
 * parsing and any edge case can fall back to `$ARGUMENTS` (the raw string).
 */

/** Split `args` into tokens, respecting "double" and 'single' quoted spans. */
export function parseArguments(args: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  let i = 0

  const flush = () => {
    if (buf.length > 0) {
      out.push(buf)
      buf = ''
    }
  }

  while (i < args.length) {
    const ch = args[i]

    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\' && i + 1 < args.length) {
        // Pass through escaped char inside quotes.
        buf += args[i + 1]
        i++
      } else {
        buf += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch ?? '')) {
      flush()
    } else {
      buf += ch
    }
    i++
  }
  flush()
  return out
}

/**
 * Apply `$ARGUMENTS` / `$1` / `$name` substitutions.
 *
 * Replacement order matters: named args first (they may collide with
 * unrelated substrings), then `$ARGUMENTS[N]`, then `$N` shorthand, then
 * the catch-all `$ARGUMENTS`. Anything not bound is left literal so
 * authors can grep for unfilled placeholders.
 */
export function substituteArguments(
  template: string,
  rawArgs: string,
  argumentNames: string[],
  transforms: {
    token?: (value: string) => string
    raw?: (value: string, tokens: string[]) => string
  } = {},
): string {
  const tokens = parseArguments(rawArgs)
  const tokenValue = transforms.token ?? ((value: string) => value)
  let out = template

  // 1. Named args. Order matters when one name is a prefix of another —
  // sort by length DESC so `$foobar` is consumed before `$foo`.
  const namesByLength = [...argumentNames].sort((a, b) => b.length - a.length)
  for (let i = 0; i < namesByLength.length; i++) {
    const name = namesByLength[i]
    if (!name) continue
    const idx = argumentNames.indexOf(name)
    const value = tokenValue(tokens[idx] ?? '')
    out = out.replace(new RegExp(`\\$${escapeRegex(name)}\\b`, 'g'), value)
  }

  // 2. $ARGUMENTS[N]
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) =>
    tokenValue(tokens[Number(idx)] ?? ''),
  )

  // 3. $N shorthand. Match only standalone $\d+ to avoid clobbering env-var
  // references like $PATH or password-style $1foo. Word-boundary `\b`
  // after the digits keeps `$10` intact.
  out = out.replace(/\$(\d+)\b/g, (m, idx) => {
    const n = Number(idx)
    return Number.isInteger(n) ? tokenValue(tokens[n] ?? '') : m
  })

  // 4. $ARGUMENTS (whole string). Must come last — substring of `$ARGUMENTS[N]`.
  out = out.replace(
    /\$ARGUMENTS\b/g,
    transforms.raw ? transforms.raw(rawArgs, tokens) : rawArgs,
  )

  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
