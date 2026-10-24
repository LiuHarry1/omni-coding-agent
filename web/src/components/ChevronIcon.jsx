/** Disclosure chevron (points right; `.open` rotates it down). */
export default function ChevronIcon({ open = false, className = '' }) {
  return (
    <svg
      className={`${className} ${open ? 'open' : ''}`}
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <polyline points='9 6 15 12 9 18' />
    </svg>
  )
}
