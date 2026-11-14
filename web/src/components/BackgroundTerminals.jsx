import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { agentApi } from '../lib/api/agent.js'

/**
 * Footer summary: "N background terminals", or "N background tasks" once a
 * background agent is among them.
 * Poll while the session is live so mid-stream bg shells appear promptly.
 * Long-lived servers stay listed as running until Stop — that is intentional.
 */

function formatElapsed(startTime, endTime, now) {
  const end = endTime ?? now
  const sec = Math.max(0, Math.floor((end - startTime) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

const isAgentTask = task => task.type === 'local_agent'

export function panelTitle(running) {
  const n = running.length
  const noun = running.some(isAgentTask) ? 'task' : 'terminal'
  return `${n} background ${noun}${n === 1 ? '' : 's'}`
}

/** What a row says about its task, and the detail shown on hover. */
export function taskRowText(task) {
  if (!isAgentTask(task)) {
    return {
      icon: '>_',
      label: task.description || task.command || task.id,
      detail: task.command || task.description,
      hint: 'Long-lived processes stay running until stopped',
    }
  }
  const steps = task.toolUses || 0
  return {
    icon: '\u25C7',
    label: task.description || task.id,
    detail: task.activity || task.description,
    hint:
      steps > 0
        ? `${task.agentType || 'Agent'} · ${steps} tool call${steps === 1 ? '' : 's'}`
        : task.agentType || 'Agent',
  }
}

export default function BackgroundTerminals() {
  const sessionId = useChatStore(s => s.currentSessionId)
  const isStreaming = useChatStore(s => s.isStreaming)
  const noteBackgroundTasks = useChatStore(s => s.noteBackgroundTasks)
  const [tasks, setTasks] = useState([])
  const [expanded, setExpanded] = useState(true)
  const [stopping, setStopping] = useState({})
  const [now, setNow] = useState(Date.now())

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setTasks([])
      return
    }
    try {
      const data = await agentApi.listSessionTasks(sessionId)
      setTasks(Array.isArray(data?.tasks) ? data.tasks : [])
    } catch {
      /* ignore */
    }
  }, [sessionId])

  const running = tasks.filter(
    t => t.status === 'running' || t.status === 'pending',
  )
  const show = running.length > 0

  // A finished task reports back in a turn the server starts on its own.
  useEffect(() => {
    if (show) noteBackgroundTasks()
  }, [show, noteBackgroundTasks])

  // Poll while streaming OR while any task is visible — otherwise a
  // mid-turn background shell stays invisible until the stream ends.
  useEffect(() => {
    if (!sessionId) {
      setTasks([])
      return undefined
    }
    void refresh()
    if (!isStreaming && !show) return undefined
    const tick = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, 1500)
    return () => clearInterval(tick)
  }, [sessionId, isStreaming, show, refresh])

  if (!show) return null

  const onStop = async (e, taskId) => {
    e.stopPropagation()
    if (!sessionId || stopping[taskId]) return
    setStopping(s => ({ ...s, [taskId]: true }))
    try {
      await agentApi.stopSessionTask(sessionId, taskId)
      await refresh()
    } catch (err) {
      console.warn('[background-terminals] stop failed', err)
    } finally {
      setStopping(s => {
        const next = { ...s }
        delete next[taskId]
        return next
      })
    }
  }

  return (
    <div className='background-terminals'>
      <div className='background-terminals__inner'>
        <button
          type='button'
          className='background-terminals__header'
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
        >
          <span className='background-terminals__chevron' aria-hidden='true'>
            {expanded ? '\u2304' : '\u203A'}
          </span>
          <span className='background-terminals__title'>
            {panelTitle(running)}
          </span>
        </button>
        {expanded && (
          <ul className='background-terminals__list'>
            {running.map(t => {
              const row = taskRowText(t)
              return (
                <li key={t.id} className='background-terminals__row'>
                  <span
                    className='background-terminals__live'
                    aria-hidden='true'
                    title='Still running'
                  />
                  <span
                    className='background-terminals__icon'
                    aria-hidden='true'
                  >
                    {row.icon}
                  </span>
                  <span
                    className='background-terminals__desc'
                    title={row.detail}
                  >
                    {row.label}
                  </span>
                  <span className='background-terminals__meta' title={row.hint}>
                    <span className='background-terminals__status'>
                      running
                    </span>
                    <span className='background-terminals__sep'>·</span>
                    {formatElapsed(t.startTime, t.endTime, now)}
                  </span>
                  <button
                    type='button'
                    className='background-terminals__stop'
                    onClick={e => onStop(e, t.id)}
                    disabled={!!stopping[t.id]}
                    aria-label={`Stop ${t.description || t.id}`}
                  >
                    {stopping[t.id] ? '…' : 'Stop'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
