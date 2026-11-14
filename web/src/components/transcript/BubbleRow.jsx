import { useState, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useChatStore } from '../../stores/chat-store.js'
import {
  bubbleToPart,
  toolBubbleToPart,
} from '../../lib/bubbles/messages-to-bubbles.js'
import { useAuthedImage } from '../../hooks/useAuthedImage.js'
import { pickCard } from '../pickToolCard.js'
import { SUPPRESSED_TOOL_CARDS } from '../../lib/tool-names.js'
import { getMdComponents } from '../../lib/markdown-components.jsx'
import CompactionRow from '../CompactionRow.jsx'
import PartRenderer from '../PartRenderer.jsx'

function UserAttachmentImg({ src, index, onOpen }) {
  const { src: resolved, failed } = useAuthedImage(src)
  if (failed || !resolved) return null
  return (
    <img
      src={resolved}
      alt={`Attachment ${index + 1}`}
      className='msg-user-img'
      onClick={() => onOpen(resolved)}
    />
  )
}

/**
 * Single canonical bubble — subscribes only to bubblesById[bubbleId].
 * @param {{ bubbleId: string, streamingTail?: boolean, embedded?: boolean }} props
 */
function BubbleRow({ bubbleId, streamingTail = false, embedded = false }) {
  const bubble = useChatStore(s => s.bubblesById[bubbleId])
  const [lightbox, setLightbox] = useState(null)

  if (!bubble) return null

  const wrap = (node, className = 'msg msg-assistant') =>
    embedded ? node : <div className={className}>{node}</div>

  if (bubble.kind === 'compact_boundary') {
    return wrap(
      <CompactionRow state='done' summary={bubble.summary} />,
      'msg msg-compact-boundary',
    )
  }

  if (bubble.kind === 'interrupted') {
    return wrap(
      <>
        Interrupted
        <span className='msg-interrupted-hint'>
          {' '}
          · What should I do instead?
        </span>
      </>,
      'msg msg-interrupted',
    )
  }

  if (bubble.kind === 'task_notification') {
    const summaries = (bubble.summaries || []).filter(Boolean)
    return wrap(
      summaries.length > 0 ? (
        summaries.map((summary, i) => <div key={i}>{summary}</div>)
      ) : (
        <div>Background task update</div>
      ),
      'msg msg-task-notification',
    )
  }

  if (bubble.kind === 'user') {
    return (
      <div
        className={
          bubble.queued ? 'msg msg-user msg-user--queued' : 'msg msg-user'
        }
        title={bubble.queued ? 'Sent while the agent was working' : undefined}
      >
        {bubble.images && bubble.images.length > 0 && (
          <div className='msg-user-images'>
            {bubble.images.map((src, i) => (
              <UserAttachmentImg
                key={src + i}
                src={src}
                index={i}
                onOpen={setLightbox}
              />
            ))}
          </div>
        )}
        {bubble.files && bubble.files.length > 0 && (
          <div className='msg-user-files'>
            {bubble.files.map((f, i) => (
              <span key={f.name + i} className='msg-user-file'>
                {f.name}
              </span>
            ))}
          </div>
        )}
        {bubble.content}
        {lightbox && (
          <div className='lightbox' onClick={() => setLightbox(null)}>
            <img src={lightbox} alt='Preview' />
          </div>
        )}
      </div>
    )
  }

  if (bubble.kind === 'tool') {
    const part = toolBubbleToPart(bubble)
    if (SUPPRESSED_TOOL_CARDS.has(part.name)) return null
    const Card = pickCard(part)
    return wrap(<Card part={part} />)
  }

  if (bubble.kind === 'assistant_text') {
    if (!bubble.content?.trim()) return null
    const mdComponents = getMdComponents({ streaming: streamingTail })
    return wrap(
      <div className='content'>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={mdComponents}
        >
          {bubble.content}
        </ReactMarkdown>
      </div>,
    )
  }

  const part = bubbleToPart(bubble)
  if (!part) return null
  return wrap(
    <PartRenderer
      part={part}
      index={0}
      rowCount={1}
      messageStreaming={!!bubble.streaming || streamingTail}
    />,
  )
}

export default memo(BubbleRow)
