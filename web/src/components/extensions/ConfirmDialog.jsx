import { useEffect, useRef, useState } from 'react'
import ModalShell from './ModalShell.jsx'

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  confirmationText,
  pending = false,
  error,
  onConfirm,
  onClose,
}) {
  const cancelRef = useRef(null)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const allowed =
    !pending && (!confirmationText || typed.trim() === confirmationText)

  return (
    <ModalShell
      open={open}
      onClose={pending ? undefined : onClose}
      title={title}
      size='small'
      className='extensions-confirm'
      initialFocusRef={cancelRef}
      shouldCloseOnBackdrop={!pending}
    >
      <form
        className='extensions-confirm__body'
        onSubmit={event => {
          event.preventDefault()
          if (allowed) onConfirm?.()
        }}
      >
        <div className='extensions-confirm__message'>{message}</div>
        {confirmationText && (
          <label className='extensions-field'>
            <span>
              Type <strong>{confirmationText}</strong> to continue
            </span>
            <input
              value={typed}
              disabled={pending}
              autoComplete='off'
              onChange={event => setTyped(event.target.value)}
            />
          </label>
        )}
        {error && (
          <div
            className='extensions-alert extensions-alert--error'
            role='alert'
          >
            {error}
          </div>
        )}
        <div className='extensions-confirm__actions'>
          <button
            ref={cancelRef}
            type='button'
            className='extensions-button'
            disabled={pending}
            onClick={onClose}
          >
            {cancelLabel}
          </button>
          <button
            type='submit'
            className={`extensions-button extensions-button--${variant}`}
            disabled={!allowed}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
