import { useEffect, useRef } from 'react'

export default function SectionNavigation({ sections, activeId, onSelect }) {
  const refs = useRef(new Map())

  useEffect(() => {
    const revealActive = () => {
      refs.current.get(activeId)?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      })
    }
    revealActive()
    window.addEventListener('resize', revealActive)
    return () => {
      window.removeEventListener('resize', revealActive)
    }
  }, [activeId])

  const move = (currentIndex, delta) => {
    const next = (currentIndex + delta + sections.length) % sections.length
    const section = sections[next]
    onSelect(section.id)
    refs.current.get(section.id)?.focus()
  }

  return (
    <nav className='extensions-nav' aria-label='AI Extensions sections'>
      <div className='extensions-nav__list' role='tablist'>
        {sections.map((section, index) => {
          const active = activeId === section.id
          const Icon = section.icon
          return (
            <button
              key={section.id}
              ref={node => {
                if (node) refs.current.set(section.id, node)
                else refs.current.delete(section.id)
              }}
              type='button'
              id={`extensions-tab-${section.id}`}
              role='tab'
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              aria-controls={`extensions-section-${section.id}`}
              className={`extensions-nav__item ${active ? 'is-active' : ''}`}
              onClick={() => onSelect(section.id)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  move(index, 1)
                } else if (
                  event.key === 'ArrowUp' ||
                  event.key === 'ArrowLeft'
                ) {
                  event.preventDefault()
                  move(index, -1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  move(0, 0)
                } else if (event.key === 'End') {
                  event.preventDefault()
                  move(sections.length - 1, 0)
                }
              }}
            >
              {Icon && <Icon aria-hidden='true' />}
              <span>{section.label}</span>
              {section.badge != null && (
                <span className='extensions-nav__badge'>{section.badge}</span>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
