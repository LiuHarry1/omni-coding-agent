import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { getMdComponents } from '../lib/markdown-components.jsx'
import ChevronIcon from './ChevronIcon.jsx'

/**
 * Thinking row: one-line label while streaming; body only when
 * the user expands. Never auto-open — stream updates must not dump reasoning
 * (or leaked system-reminder / tool-prompt text) into the transcript.
 */
export default function ReasoningBlock({ part }) {
  const [open, setOpen] = useState(false)
  const isStreaming = part.status === 'streaming'
  const mdComponents = getMdComponents({ streaming: isStreaming })

  // Strip agent-facing reminder wrappers if the model echoed them into reasoning.
  const displayContent = (part.content || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .trim()

  const showBody = open && !!displayContent

  return (
    <div className={`reasoning-block ${isStreaming ? 'streaming' : 'done'}`}>
      <button
        type='button'
        className='reasoning-toggle'
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span
          className={`reasoning-action ${isStreaming ? 'shimmer-text' : ''}`}
        >
          {isStreaming ? 'Thinking' : 'Thought'}
        </span>
        {!isStreaming && (
          <span className='reasoning-details'>for {part.duration ?? 0}s</span>
        )}
        <ChevronIcon open={open} className='reasoning-chevron' />
      </button>
      {showBody && (
        <div className='reasoning-content'>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {displayContent}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}
