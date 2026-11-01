import { useCallback, useEffect, useRef, useState } from 'react'
import { agentApi } from '../lib/api/agent.js'
import { useChatStore } from '../stores/chat-store.js'
import { useWorkspaceContextStore } from '../stores/workspace-context-store.js'

function pad(n) {
  return String(n).padStart(2, '0')
}

function tomorrowAtNine() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}

function toDateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function toTimeValue(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultCustom() {
  const d = new Date(Date.now() + 30 * 60 * 1000)
  d.setSeconds(0, 0)
  return d
}

const ONCE_CHIPS = [
  { id: '5m', label: '5 min', offsetMs: 5 * 60 * 1000 },
  { id: '15m', label: '15 min', offsetMs: 15 * 60 * 1000 },
  { id: '1h', label: '1 hour', offsetMs: 60 * 60 * 1000 },
  { id: 'tomorrow', label: 'Tomorrow 9:00', at: tomorrowAtNine },
]

const REPEAT_CHIPS = [
  { id: 'every15', label: 'Every 15 min', cron: '*/15 * * * *' },
  { id: 'hourly', label: 'Hourly', cron: '0 * * * *' },
  { id: 'daily', label: 'Daily 9:00', cron: '0 9 * * *' },
  { id: 'weekdays', label: 'Weekdays 9:00', cron: '0 9 * * 1-5' },
]

function formatRelativeNext(ms) {
  if (!ms) return ''
  const diff = ms - Date.now()
  if (diff <= 0) return 'due'
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'in under a minute'
  if (min < 90) return `in ${min} min`
  const hours = Math.round(min / 60)
  if (hours < 36) return `in ${hours} hr`
  const days = Math.round(hours / 24)
  return `in ${days} day${days === 1 ? '' : 's'}`
}

function resolveOnceAt(chipId, customDate, customTime) {
  if (chipId === 'custom') {
    const ms = new Date(`${customDate}T${customTime}`).getTime()
    return Number.isFinite(ms) ? ms : null
  }
  const chip = ONCE_CHIPS.find(c => c.id === chipId)
  if (!chip) return null
  if (chip.offsetMs) return Date.now() + chip.offsetMs
  if (chip.at) return chip.at().getTime()
  return null
}

export default function SchedulePicker() {
  const workspace = useWorkspaceContextStore(s => s.cwd)
  const workspaceHandle = useWorkspaceContextStore(s => s.handle)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const switchSession = useChatStore(s => s.switchSession)
  const refreshSessions = useChatStore(s => s.refreshSessions)
  const setLiveNeeded = useChatStore(s => s.setLiveNeeded)
  const agentType = useChatStore(s => s.agentType)
  const agentMode = useChatStore(s => s.agentMode)

  const [enabled, setEnabled] = useState(null)
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState([])
  const [kind, setKind] = useState('once')
  const [chipId, setChipId] = useState('5m')
  const [customDate, setCustomDate] = useState(() =>
    toDateValue(defaultCustom()),
  )
  const [customTime, setCustomTime] = useState(() =>
    toTimeValue(defaultCustom()),
  )
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  const promptRef = useRef(null)

  const load = useCallback(async () => {
    const fetchFlag = sessionId =>
      agentApi.getScheduledTasks(sessionId, workspace || undefined)

    try {
      let data
      try {
        data = await fetchFlag(currentSessionId || undefined)
      } catch (err) {
        if (err.status === 404 && currentSessionId) {
          data = await fetchFlag(undefined)
        } else {
          throw err
        }
      }
      setEnabled(Boolean(data.enabled))
      const nextTasks = Array.isArray(data.tasks) ? data.tasks : []
      setTasks(nextTasks)
      if (currentSessionId) setLiveNeeded(nextTasks.length > 0)
    } catch {
      setEnabled(false)
      setTasks([])
    }
  }, [workspace, currentSessionId, setLiveNeeded])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onDoc = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => promptRef.current?.focus())
    }
  }, [open])

  const selectOnce = id => {
    setKind('once')
    setChipId(id)
    setError(null)
    if (id === 'custom') {
      const d = defaultCustom()
      setCustomDate(toDateValue(d))
      setCustomTime(toTimeValue(d))
    }
  }

  const selectRepeat = id => {
    setKind('repeat')
    setChipId(id)
    setError(null)
  }

  const handleOpen = async e => {
    e.stopPropagation()
    const next = !open
    setOpen(next)
    setError(null)
    if (next) {
      setKind('once')
      setChipId('5m')
      await load()
    }
  }

  const handleCreate = async e => {
    e.preventDefault()
    const text = prompt.trim()
    if (!text) {
      setError('Add a prompt first.')
      promptRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const body = {
        prompt: text,
        workspace: workspace || undefined,
        session_id: currentSessionId || undefined,
        environmentId: workspaceHandle?.environmentId,
        agentType: agentType || null,
        mode: agentMode || undefined,
      }
      if (kind === 'once') {
        const atMs = resolveOnceAt(chipId, customDate, customTime)
        if (atMs == null || atMs <= Date.now()) {
          setError('Pick a time in the future.')
          setBusy(false)
          return
        }
        body.at = new Date(atMs).toISOString()
        body.recurring = false
      } else {
        const chip = REPEAT_CHIPS.find(c => c.id === chipId)
        if (!chip) {
          setError('Pick how often this should run.')
          setBusy(false)
          return
        }
        body.cron = chip.cron
        body.recurring = true
      }
      const create = sessionId =>
        agentApi.createScheduledTask({ ...body, session_id: sessionId })
      let data
      try {
        data = await create(currentSessionId || undefined)
      } catch (err) {
        if (err.status === 404 && currentSessionId) {
          data = await create(undefined)
        } else {
          throw err
        }
      }
      if (data.session_id) {
        if (data.session_id !== currentSessionId) {
          await switchSession(data.session_id)
        } else {
          setLiveNeeded(true)
        }
        await refreshSessions()
      }
      setPrompt('')
      await load()
    } catch (err) {
      setError(err.message || 'Could not schedule')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async id => {
    if (!currentSessionId) return
    setError(null)
    try {
      await agentApi.deleteScheduledTask(
        id,
        currentSessionId,
        workspace || undefined,
      )
      setTasks(prev => {
        const next = prev.filter(t => t.id !== id)
        if (next.length === 0) setLiveNeeded(false)
        return next
      })
    } catch (err) {
      setError(err.message || 'Could not cancel')
    }
  }

  if (enabled !== true) return null

  return (
    <div className='schedule-picker' ref={ref}>
      <button
        type='button'
        className={`attach-btn schedule-picker__btn${open ? ' schedule-picker__btn--open' : ''}`}
        onClick={handleOpen}
        title='Scheduled'
        aria-label='Scheduled'
        aria-expanded={open}
        aria-haspopup='dialog'
      >
        <svg
          width='16'
          height='16'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <circle cx='12' cy='12' r='9' />
          <polyline points='12 7 12 12 15 14' />
        </svg>
        {tasks.length > 0 && (
          <span className='schedule-picker__badge'>{tasks.length}</span>
        )}
      </button>
      {open && (
        <div
          className='schedule-picker__flyout'
          role='dialog'
          aria-label='Scheduled'
        >
          <div className='schedule-picker__head'>
            <span className='schedule-picker__title'>Scheduled</span>
            {tasks.length > 0 && (
              <span className='schedule-picker__count'>{tasks.length}</span>
            )}
          </div>
          <form className='schedule-picker__form' onSubmit={handleCreate}>
            <textarea
              ref={promptRef}
              className='schedule-picker__prompt'
              rows={2}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder='What should the agent do later?'
            />
            <div className='schedule-picker__section'>Later</div>
            <div className='schedule-picker__chips'>
              {ONCE_CHIPS.map(chip => (
                <button
                  key={chip.id}
                  type='button'
                  className={`schedule-picker__chip${kind === 'once' && chipId === chip.id ? ' schedule-picker__chip--on' : ''}`}
                  onClick={() => selectOnce(chip.id)}
                >
                  {chip.label}
                </button>
              ))}
              <button
                type='button'
                className={`schedule-picker__chip${kind === 'once' && chipId === 'custom' ? ' schedule-picker__chip--on' : ''}`}
                onClick={() => selectOnce('custom')}
              >
                Custom
              </button>
            </div>
            {kind === 'once' && chipId === 'custom' && (
              <div className='schedule-picker__custom'>
                <input
                  type='date'
                  value={customDate}
                  onChange={e => setCustomDate(e.target.value)}
                  aria-label='Date'
                />
                <input
                  type='time'
                  value={customTime}
                  onChange={e => setCustomTime(e.target.value)}
                  aria-label='Time'
                />
              </div>
            )}
            <div className='schedule-picker__section'>Repeat</div>
            <div className='schedule-picker__chips'>
              {REPEAT_CHIPS.map(chip => (
                <button
                  key={chip.id}
                  type='button'
                  className={`schedule-picker__chip${kind === 'repeat' && chipId === chip.id ? ' schedule-picker__chip--on' : ''}`}
                  onClick={() => selectRepeat(chip.id)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
            {kind === 'repeat' && (
              <div className='schedule-picker__hint'>
                Repeating jobs stop after 7 days.
              </div>
            )}
            {error && <div className='schedule-picker__error'>{error}</div>}
            <div className='schedule-picker__actions'>
              <button
                type='submit'
                className='schedule-picker__submit'
                disabled={busy}
              >
                {busy ? 'Scheduling…' : 'Schedule'}
              </button>
            </div>
          </form>
          <div className='schedule-picker__list'>
            {tasks.length === 0 ? (
              <div className='schedule-picker__empty'>No upcoming runs</div>
            ) : (
              tasks.map(task => (
                <div key={task.id} className='schedule-picker__item'>
                  <div className='schedule-picker__item-body'>
                    <div
                      className='schedule-picker__item-title'
                      title={task.prompt}
                    >
                      {task.prompt}
                    </div>
                    <div className='schedule-picker__item-meta'>
                      {task.schedule}
                      {task.nextRunAtMs
                        ? ` · ${formatRelativeNext(task.nextRunAtMs)}`
                        : ''}
                    </div>
                  </div>
                  <button
                    type='button'
                    className='schedule-picker__delete'
                    title='Cancel'
                    onClick={() => handleDelete(task.id)}
                  >
                    <svg
                      width='12'
                      height='12'
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='2'
                      strokeLinecap='round'
                    >
                      <polyline points='3 6 5 6 21 6' />
                      <path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
