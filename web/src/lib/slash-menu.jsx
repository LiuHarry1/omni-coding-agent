/**
 * Slash-command picker helpers for the composer (InputArea).
 */

export const INITIAL_VISIBLE = 3

/** Returns partial name after `/`, or null when not in slash-pick mode. */
export function getSlashFilter(text) {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const rest = trimmed.slice(1)
  if (rest.includes(' ') || rest.includes('\n')) return null
  return rest.toLowerCase()
}

/** Group matches: Skills → user Commands → Built-in. */
export function groupEntries(matches) {
  const skills = matches
    .filter(e => e.kind === 'skill')
    .sort((a, b) => a.name.localeCompare(b.name))
  const commands = matches
    .filter(e => e.kind === 'command')
    .sort((a, b) => a.name.localeCompare(b.name))
  const builtins = matches
    .filter(e => e.kind === 'built-in' && e.name !== 'commands')
    .sort((a, b) => a.name.localeCompare(b.name))
  const mcpPrompts = matches
    .filter(e => e.kind === 'mcp-prompt')
    .sort((a, b) => a.name.localeCompare(b.name))

  const groups = []
  if (skills.length > 0)
    groups.push({ label: 'Skills', icon: 'skill', items: skills })
  if (commands.length > 0)
    groups.push({ label: 'Commands', icon: 'command', items: commands })
  if (builtins.length > 0)
    groups.push({ label: 'Built-in', icon: 'command', items: builtins })
  if (mcpPrompts.length > 0)
    groups.push({ label: 'MCP prompts', icon: 'command', items: mcpPrompts })
  return groups
}

/** Flat navigable rows for keyboard + mouse (items, show more, show less). */
export function rowFromSectionRow(section, row) {
  if (row.kind === 'item') {
    return {
      kind: 'item',
      groupLabel: section.label,
      groupIcon: section.icon,
      entry: row.entry,
    }
  }
  if (row.kind === 'more') {
    return { kind: 'more', groupLabel: section.label, count: row.count }
  }
  return { kind: 'less', groupLabel: section.label }
}

export function clearSlashToken(value) {
  return value.replace(/^\s*\/[^\s\n]*/, '')
}

export function SlashMenuIcon({ type }) {
  if (type === 'skill') {
    return (
      <svg
        className='slash-menu__icon'
        width='14'
        height='14'
        viewBox='0 0 24 24'
        fill='currentColor'
        aria-hidden='true'
      >
        <path d='M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z' />
      </svg>
    )
  }
  return (
    <svg
      className='slash-menu__icon'
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='currentColor'
      aria-hidden='true'
    >
      <path d='M13 2 3 14h7l-1 8 10-12h-7l1-8z' />
    </svg>
  )
}
