import { useChatStore } from '../stores/chat-store.js'

/** How full the conversation is, once the server warns about it. */
export default function ContextNotice() {
  const notice = useChatStore(s => s.notice)
  if (notice?.kind === 'context_warning') {
    return (
      <div className='context-notice' role='status'>
        Context left: {notice.percent_left}% — older messages will be summarized
        soon.
      </div>
    )
  }
  if (notice?.kind === 'context_blocked') {
    return (
      <div className='context-notice context-notice--blocked' role='alert'>
        The conversation no longer fits the model&apos;s context. Run /compact
        or start a new conversation.
      </div>
    )
  }
  return null
}
