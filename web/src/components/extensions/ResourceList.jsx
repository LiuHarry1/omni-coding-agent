import { useMemo, useRef, useState } from 'react'

export default function ResourceList({
  title,
  items,
  selectedId,
  getId = item => item.id ?? item.path ?? item.name,
  getLabel = item => item.name,
  getSearchText,
  renderMeta,
  renderBadges,
  onSelect,
  headerActions,
  searchPlaceholder = 'Search…',
  emptyMessage = 'Nothing here yet.',
  loading = false,
}) {
  const [query, setQuery] = useState('')
  const itemRefs = useRef(new Map())
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter(item => {
      const haystack = getSearchText?.(item) ?? getLabel(item)
      return String(haystack || '')
        .toLowerCase()
        .includes(needle)
    })
  }, [getLabel, getSearchText, items, query])

  const selectRelative = (currentId, delta) => {
    if (filtered.length === 0) return
    const index = Math.max(
      0,
      filtered.findIndex(item => getId(item) === currentId),
    )
    const next = filtered[(index + delta + filtered.length) % filtered.length]
    onSelect?.(next)
    itemRefs.current.get(getId(next))?.focus()
  }

  return (
    <aside className='extensions-resource-list'>
      <div className='extensions-resource-list__head'>
        <div>
          <h3>{title}</h3>
          <span>
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        {headerActions}
      </div>
      <label className='extensions-search'>
        <span className='extensions-sr-only'>Search {title}</span>
        <svg
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          aria-hidden='true'
        >
          <circle cx='11' cy='11' r='7' />
          <path d='m20 20-3.4-3.4' />
        </svg>
        <input
          value={query}
          placeholder={searchPlaceholder}
          onChange={event => setQuery(event.target.value)}
        />
      </label>
      <div
        className='extensions-resource-list__items thin-scrollbar'
        role='listbox'
        aria-label={title}
      >
        {loading && (
          <div className='extensions-empty'>
            <span className='spinner' aria-hidden='true' />
            <span>Loading…</span>
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className='extensions-empty'>{emptyMessage}</div>
        )}
        {!loading &&
          filtered.map(item => {
            const id = getId(item)
            const selected = id === selectedId
            return (
              <button
                key={id}
                ref={node => {
                  if (node) itemRefs.current.set(id, node)
                  else itemRefs.current.delete(id)
                }}
                type='button'
                role='option'
                aria-selected={selected}
                className={`extensions-resource-row ${selected ? 'is-selected' : ''}`}
                onClick={() => onSelect?.(item)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    selectRelative(id, 1)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    selectRelative(id, -1)
                  }
                }}
              >
                <span className='extensions-resource-row__line'>
                  <span className='extensions-resource-row__name'>
                    {getLabel(item)}
                  </span>
                  {renderBadges?.(item)}
                </span>
                {renderMeta && (
                  <span className='extensions-resource-row__meta'>
                    {renderMeta(item)}
                  </span>
                )}
              </button>
            )
          })}
      </div>
    </aside>
  )
}
