export default function DetailPane({
  title,
  subtitle,
  badges,
  actions,
  children,
  empty = false,
  emptyContent,
  className = '',
}) {
  if (empty) {
    return (
      <section className={`extensions-detail ${className}`}>
        <div className='extensions-detail__empty'>{emptyContent}</div>
      </section>
    )
  }

  return (
    <section className={`extensions-detail ${className}`}>
      <header className='extensions-detail__head'>
        <div className='extensions-detail__identity'>
          <div className='extensions-detail__title-line'>
            <h3>{title}</h3>
            {badges}
          </div>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className='extensions-detail__actions'>{actions}</div>}
      </header>
      <div className='extensions-detail__body thin-scrollbar'>{children}</div>
    </section>
  )
}
