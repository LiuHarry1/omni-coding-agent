import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatActions } from '../lib/chat-actions.jsx'
import { getMdComponents } from '../lib/markdown-components.jsx'
import { formatPlanDisplayPath } from '../lib/plan-utils.js'

const COLLAPSED_MAX_HEIGHT = 280

export function planApprovalActionLabels(submittingAction) {
  return {
    keepPlanning:
      submittingAction === 'keep-planning' ? 'Keeping…' : 'Keep planning',
    build: submittingAction === 'build' ? 'Building…' : 'Build',
  }
}

export default function PlanApprovalCard({ part, onApprove }) {
  const { approvePlan } = useChatActions()
  const submitPlan = onApprove ?? approvePlan
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [content, setContent] = useState(part.plan ?? '')
  const [submittingAction, setSubmittingAction] = useState(null)

  const done = part.status === 'answered'
  const pending = part.status === 'pending'
  const submitting = submittingAction != null
  const actionLabels = planApprovalActionLabels(submittingAction)

  useEffect(() => {
    if (!editing && part.plan != null) {
      setContent(part.plan)
    }
  }, [part.plan, editing])

  // User cannot see the plan until ExitPlanMode — only pending/answered render.
  if (!pending && !done) return null

  const displayPath = formatPlanDisplayPath(part.filePath)
  const isLong =
    (content?.split('\n').length ?? 0) > 18 || (content?.length ?? 0) > 1200

  const handleApprove = async approved => {
    if (submitting || done || !part.requestId) return
    setSubmittingAction(approved ? 'build' : 'keep-planning')
    try {
      await submitPlan(part.requestId, {
        approved,
        editedPlan: editing && approved ? content : undefined,
        targetMode: approved ? 'agent' : undefined,
        reason: approved ? undefined : 'user_rejected',
      })
    } catch (err) {
      console.error('[PlanApproval] failed:', err)
    } finally {
      setSubmittingAction(null)
    }
  }

  if (done) {
    // Approved: hide — implementation shows via Write/Bash tool cards above.
    if (part.approved) return null
    return (
      <div className='plan-card plan-card--done'>
        <span className='plan-card__badge'>Plan revision requested</span>
      </div>
    )
  }

  return (
    <div className='plan-card'>
      <div className='plan-card__header'>
        <div className='plan-card__heading'>
          <span className='plan-card__title'>Implementation Plan</span>
          {displayPath && (
            <span className='plan-card__path' title={part.filePath}>
              {displayPath}
            </span>
          )}
        </div>
      </div>

      {editing ? (
        <textarea
          className='plan-card__editor'
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={16}
        />
      ) : (
        <div
          className={`plan-card__body${!expanded && isLong ? ' plan-card__body--collapsed' : ''}`}
          style={
            !expanded && isLong
              ? { maxHeight: COLLAPSED_MAX_HEIGHT }
              : undefined
          }
        >
          <div className='plan-card__markdown'>
            {content ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={getMdComponents({ streaming: false })}
              >
                {content}
              </ReactMarkdown>
            ) : (
              <span className='plan-card__placeholder'>No plan content</span>
            )}
          </div>
        </div>
      )}

      {!editing && isLong && (
        <button
          type='button'
          className='plan-card__toggle'
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show less' : 'Show full plan'}
        </button>
      )}

      <div className='plan-card__actions'>
        <button
          type='button'
          className='plan-card__btn plan-card__btn--secondary'
          disabled={submitting}
          onClick={() => setEditing(v => !v)}
        >
          {editing ? 'Preview' : 'Edit plan'}
        </button>
        <button
          type='button'
          className='plan-card__btn plan-card__btn--secondary'
          disabled={submitting}
          onClick={() => handleApprove(false)}
        >
          {actionLabels.keepPlanning}
        </button>
        <button
          type='button'
          className='plan-card__btn plan-card__btn--primary'
          disabled={submitting}
          onClick={() => handleApprove(true)}
        >
          {actionLabels.build}
        </button>
      </div>
    </div>
  )
}
