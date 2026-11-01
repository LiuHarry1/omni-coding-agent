import { useState, useRef, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { useWorkspaceContextStore } from '../stores/workspace-context-store.js'

const MODE_META = {
  agent: { id: 'agent', label: 'Agent', desc: 'Edit and run commands' },
  ask: { id: 'ask', label: 'Ask', desc: 'Read-only exploration' },
  plan: { id: 'plan', label: 'Plan', desc: 'Design before building' },
}

export default function ModePicker() {
  const agentMode = useChatStore(s => s.agentMode)
  const agentType = useChatStore(s => s.agentType)
  const setAgentMode = useChatStore(s => s.setAgentMode)
  const setAgentType = useChatStore(s => s.setAgentType)
  const loadAgentPicker = useChatStore(s => s.loadAgentPicker)
  const workspaceHandle = useWorkspaceContextStore(s => s.handle)
  const agentPicker = useChatStore(s => s.agentPicker)
  const primaryAgents = useChatStore(s => s.agentPickerPrimaries)
  const loaded = useChatStore(s => s.agentPickerLoaded)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(null)
  const ref = useRef(null)
  const flyoutRef = useRef(null)

  const modes = agentPicker?.modes ?? ['agent', 'ask', 'plan']

  const showTip = (e, label, desc) => {
    if (!desc) {
      setHovered(null)
      return
    }
    const flyout = flyoutRef.current
    const row = e.currentTarget
    if (!flyout || !row) {
      setHovered({ label, desc, top: 0 })
      return
    }
    const flyRect = flyout.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const top = rowRect.top - flyRect.top + rowRect.height / 2
    setHovered({ label, desc, top })
  }

  const hideTip = () => setHovered(null)

  useEffect(() => {
    loadAgentPicker?.(workspaceHandle || undefined)
  }, [workspaceHandle, loadAgentPicker])

  const modeRows = useMemo(
    () => modes.map(id => MODE_META[id]).filter(Boolean),
    [modes],
  )

  const current = useMemo(() => {
    if (agentType) {
      const specialist = primaryAgents.find(a => a.id === agentType)
      if (specialist) {
        return {
          id: specialist.id,
          label: specialist.label,
          pillClass: 'specialist',
        }
      }
      return { id: agentType, label: agentType, pillClass: 'specialist' }
    }
    const mode =
      modeRows.find(m => m.id === agentMode) ?? modeRows[0] ?? MODE_META.agent
    return { id: mode.id, label: mode.label, pillClass: mode.id }
  }, [agentMode, agentType, primaryAgents, modeRows])

  const optionCount = modeRows.length + primaryAgents.length
  const singleOption = optionCount <= 1

  useEffect(() => {
    if (!open) setHovered(null)
  }, [open])

  useEffect(() => {
    const onDoc = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const selectMode = id => {
    if (!modes.includes(id)) return
    setAgentMode(id)
    setOpen(false)
  }

  const selectSpecialist = id => {
    if (!primaryAgents.some(a => a.id === id)) return
    setAgentType(id)
    setOpen(false)
  }

  const isModeActive = id => !agentType && agentMode === id
  const isSpecialistActive = id => agentType === id

  const checkIcon = (
    <svg
      className='mode-picker__check'
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      aria-hidden='true'
    >
      <polyline points='20 6 9 17 4 12' />
    </svg>
  )

  const renderRow = ({ key, label, desc, active, onClick }) => (
    <button
      key={key}
      type='button'
      role='option'
      aria-selected={active}
      aria-description={desc || undefined}
      className={`mode-picker__item${active ? ' mode-picker__item--active' : ''}`}
      onClick={onClick}
      onMouseEnter={e => showTip(e, label, desc)}
      onFocus={e => showTip(e, label, desc)}
      onMouseLeave={hideTip}
      onBlur={hideTip}
    >
      <span className='mode-picker__item-label'>{label}</span>
      {active && checkIcon}
    </button>
  )

  return (
    <div className='mode-picker' ref={ref}>
      <button
        type='button'
        className={`mode-pill mode-pill--${current.pillClass}${open ? ' mode-pill--open' : ''}${singleOption ? ' mode-pill--fixed' : ''}`}
        onClick={() => {
          if (singleOption) return
          setOpen(v => !v)
        }}
        aria-haspopup={singleOption ? undefined : 'listbox'}
        aria-expanded={singleOption ? undefined : open}
        aria-disabled={singleOption || !loaded ? true : undefined}
        title={singleOption ? current.label : undefined}
      >
        <span className='mode-pill__label'>{current.label}</span>
        {!singleOption && (
          <svg
            className={`mode-pill__chevron${open ? ' mode-pill__chevron--open' : ''}`}
            width='12'
            height='12'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2.5'
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
          >
            <polyline points='6 9 12 15 18 9' />
          </svg>
        )}
      </button>
      {open && !singleOption && (
        <div className='mode-picker__flyout' ref={flyoutRef}>
          {hovered?.desc ? (
            <div
              className='mode-picker__tip'
              role='tooltip'
              style={{ top: hovered.top ?? 0 }}
            >
              {hovered.desc}
            </div>
          ) : null}
          <div
            className='mode-picker__menu'
            role='listbox'
            aria-label='Select mode'
          >
            {modeRows.map(m =>
              renderRow({
                key: m.id,
                label: m.label,
                desc: m.desc,
                active: isModeActive(m.id),
                onClick: () => selectMode(m.id),
              }),
            )}
            {primaryAgents.length > 0 && modeRows.length > 0 && (
              <div className='mode-picker__divider' role='separator' />
            )}
            {primaryAgents.map(a =>
              renderRow({
                key: a.id,
                label: a.label,
                desc: a.desc,
                active: isSpecialistActive(a.id),
                onClick: () => selectSpecialist(a.id),
              }),
            )}
          </div>
        </div>
      )}
    </div>
  )
}
