import { useState } from 'react'
import { useChatActions } from '../lib/chat-actions.jsx'

function parentDir(filePath) {
  const normalized = filePath.replace(/[/\\]+$/, '')
  const idx = Math.max(
    normalized.lastIndexOf('/'),
    normalized.lastIndexOf('\\'),
  )
  if (idx <= 0) return normalized
  return normalized.slice(0, idx) || normalized
}

/** Parse path from ask message (supports current + legacy copy). */
function parseAskTarget(description) {
  if (typeof description !== 'string' || !description.trim()) return null
  const match = description.match(
    /(?:Permission needed to|permissions to) (?:read from|write to) (.+?)(?:, but you haven't granted it yet)?\.?\s*$/i,
  )
  return match?.[1]?.trim() || null
}

function resultHint(description, choice) {
  const target = parseAskTarget(description)
  if (!target) return null
  // Always allow grants the parent directory, not a single file.
  if (choice === 'always') return parentDir(target)
  return target
}

function isOutsideAsk(description) {
  return parseAskTarget(description) != null
}

export default function CanUseToolCard({ part }) {
  const { answerCanUseTool } = useChatActions()
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(
    part.status === 'answered' || part.status === 'done',
  )
  const [choice, setChoice] = useState(part.decision)

  const handle = async decision => {
    if (submitting || done || !part.id) return
    setSubmitting(true)
    try {
      await answerCanUseTool(part.id, decision)
      setChoice(decision)
      setDone(true)
    } catch (err) {
      console.error('[CanUseTool] submit failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const target = parseAskTarget(part.description)
  const outside = isOutsideAsk(part.description)
  const toolLabel = part.title || part.toolName || 'File permission'
  // A command prompt carries the command and the rules "Always allow" adds.
  const command = typeof part.command === 'string' ? part.command : null
  const alwaysRules = Array.isArray(part.alwaysRules) ? part.alwaysRules : []
  const canAlwaysAllow = command == null || alwaysRules.length > 0

  if (done) {
    const label =
      choice === 'always'
        ? 'Always allowed'
        : choice === 'allow'
          ? 'Allowed'
          : 'Rejected'
    const hint =
      command != null
        ? choice === 'always' && alwaysRules.length > 0
          ? alwaysRules.join(', ')
          : command
        : resultHint(part.description, choice)
    const tone =
      choice === 'reject' ? 'perm-card--rejected' : 'perm-card--allowed'
    return (
      <div className={`ask-card perm-card perm-card--done ${tone}`}>
        <div className='perm-card__done-row'>
          <span className='perm-card__status'>{label}</span>
          {choice === 'always' && hint && (
            <span className='perm-card__badge'>
              {command != null ? 'Rule' : 'Directory'}
            </span>
          )}
        </div>
        {hint && <code className='perm-card__path'>{hint}</code>}
      </div>
    )
  }

  return (
    <div className='ask-card perm-card'>
      <div className='perm-card__header'>
        <span className='perm-card__title'>{toolLabel}</span>
        {outside && <span className='perm-card__badge'>Outside workspace</span>}
      </div>
      {command != null ? (
        <code className='perm-card__path'>{command}</code>
      ) : target ? (
        <code className='perm-card__path'>{target}</code>
      ) : (
        part.description && (
          <p className='perm-card__fallback'>{part.description}</p>
        )
      )}
      <div className='perm-card__actions'>
        <button
          type='button'
          className='perm-card__btn perm-card__btn--primary'
          disabled={submitting}
          onClick={() => handle('allow')}
        >
          Allow
        </button>
        {canAlwaysAllow && (
          <button
            type='button'
            className='perm-card__btn'
            disabled={submitting}
            title={alwaysRules.length > 0 ? alwaysRules.join(', ') : undefined}
            onClick={() => handle('always')}
          >
            {alwaysRules.length > 0
              ? `Always allow ${alwaysRules.join(', ')}`
              : 'Always allow'}
          </button>
        )}
        <button
          type='button'
          className='perm-card__btn perm-card__btn--reject'
          disabled={submitting}
          onClick={() => handle('reject')}
        >
          Reject
        </button>
      </div>
    </div>
  )
}
