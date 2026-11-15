import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'

const fileCount = n => `${n} file${n === 1 ? '' : 's'}`
const shortPath = file => file.split('/').slice(-2).join('/')

/**
 * Rewind to before a user message, or fork a new session from it. Putting
 * the files back overwrites what is on disk, so that one asks first.
 */
export default function UserMessageActions({ messageId }) {
  const isStreaming = useChatStore(s => s.isStreaming)
  const readOnly = useChatStore(s => s.sessionReadOnly)
  const previewRewind = useChatStore(s => s.previewRewind)
  const rewindTo = useChatStore(s => s.rewindTo)
  const forkFrom = useChatStore(s => s.forkFrom)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPreview(null)
    setConfirming(false)
    setError(null)
    previewRewind(messageId)
      .then(data => !cancelled && setPreview(data))
      .catch(() => !cancelled && setPreview({ changed_files: [] }))
    const onDown = e => {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      cancelled = true
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, messageId, previewRewind])

  if (readOnly) return null

  const run = async action => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setOpen(false)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const changed = preview?.changed_files ?? []
  const created = new Set(preview?.created_files ?? [])
  const canRestore = !!preview?.can_restore_files && changed.length > 0

  return (
    <div className='msg-user-actions' ref={ref}>
      <button
        type='button'
        className='msg-user-actions-toggle'
        title='Rewind or fork from here'
        aria-label='Rewind or fork from here'
        disabled={isStreaming}
        onClick={() => setOpen(o => !o)}
      >
        ↶
      </button>
      {open && confirming && (
        <div className='msg-user-actions-menu' role='dialog'>
          <div className='msg-user-actions-confirm'>
            Put {fileCount(changed.length)} back the way{' '}
            {changed.length === 1 ? 'it was' : 'they were'} before this message?
          </div>
          <ul className='msg-user-actions-files'>
            {changed.map(file => (
              <li key={file} title={file}>
                {shortPath(file)}
                {created.has(file) && <em> (will be deleted)</em>}
              </li>
            ))}
          </ul>
          <div className='msg-user-actions-note'>
            Whatever is in these files now is overwritten, your own edits
            included. Files changed by shell commands are not put back.
          </div>
          <button
            type='button'
            disabled={busy}
            onClick={() =>
              run(() => rewindTo(messageId, { restoreFiles: true }))
            }
          >
            Restore files and rewind
          </button>
          <button
            type='button'
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
          {error && <div className='msg-user-actions-error'>{error}</div>}
        </div>
      )}
      {open && !confirming && (
        <div className='msg-user-actions-menu' role='menu'>
          <button
            type='button'
            role='menuitem'
            disabled={busy}
            onClick={() => run(() => rewindTo(messageId))}
          >
            Rewind conversation to here
          </button>
          {canRestore && (
            <button
              type='button'
              role='menuitem'
              disabled={busy}
              title={changed.join('\n')}
              onClick={() => setConfirming(true)}
            >
              Rewind and restore {fileCount(changed.length)}…
            </button>
          )}
          <button
            type='button'
            role='menuitem'
            disabled={busy}
            onClick={() => run(() => forkFrom(messageId))}
          >
            Fork a new session from here
          </button>
          {error && <div className='msg-user-actions-error'>{error}</div>}
        </div>
      )}
    </div>
  )
}
