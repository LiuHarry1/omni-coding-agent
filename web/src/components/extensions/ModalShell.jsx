import { useEffect, useId, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const modalStack = []

export default function ModalShell({
  open,
  onClose,
  title,
  subtitle,
  children,
  className = '',
  size = 'large',
  initialFocusRef,
  headerActions,
  closeLabel = 'Close',
  shouldCloseOnBackdrop = true,
}) {
  const generatedId = useId()
  const titleId = `extensions-modal-title-${generatedId}`
  const descriptionId = subtitle
    ? `extensions-modal-description-${generatedId}`
    : undefined
  const dialogRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const tokenRef = useRef(Symbol('modal'))
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const token = tokenRef.current
    restoreFocusRef.current = document.activeElement
    modalStack.push(token)

    const frame = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ||
        dialogRef.current?.querySelector(FOCUSABLE) ||
        dialogRef.current
      target?.focus()
    })

    const onKeyDown = event => {
      if (modalStack.at(-1) !== token) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = [
        ...dialogRef.current.querySelectorAll(FOCUSABLE),
      ].filter(
        element =>
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.getClientRects().length > 0,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      const index = modalStack.lastIndexOf(token)
      if (index >= 0) modalStack.splice(index, 1)
      const previous = restoreFocusRef.current
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus()
      })
    }
  }, [initialFocusRef, open])

  if (!open) return null

  return (
    <div
      className='extensions-modal-backdrop'
      role='presentation'
      onMouseDown={event => {
        if (
          shouldCloseOnBackdrop &&
          event.target === event.currentTarget &&
          modalStack.at(-1) === tokenRef.current
        ) {
          onClose?.()
        }
      }}
    >
      <section
        ref={dialogRef}
        className={`extensions-modal extensions-modal--${size} ${className}`}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className='extensions-modal__header'>
          <div className='extensions-modal__heading'>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p id={descriptionId}>{subtitle}</p>}
          </div>
          <div className='extensions-modal__header-actions'>
            {headerActions}
            <button
              type='button'
              className='extensions-icon-button'
              onClick={onClose}
              disabled={!onClose}
              aria-label={closeLabel}
              title={closeLabel}
            >
              <span aria-hidden='true'>×</span>
            </button>
          </div>
        </header>
        {children}
      </section>
    </div>
  )
}
