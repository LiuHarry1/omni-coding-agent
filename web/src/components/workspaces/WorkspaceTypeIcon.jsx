export default function WorkspaceTypeIcon({ kind }) {
  if (kind === 'git') {
    return (
      <svg viewBox='0 0 24 24' aria-hidden='true'>
        <circle cx='6' cy='5' r='2' />
        <circle cx='6' cy='19' r='2' />
        <circle cx='18' cy='8' r='2' />
        <path d='M6 7v10M8 7.5c5 0 4 1 8 1' />
      </svg>
    )
  }
  if (kind === 'cloud') {
    return (
      <svg viewBox='0 0 24 24' aria-hidden='true'>
        <path d='M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4-1.7A5 5 0 0 0 7 18Z' />
      </svg>
    )
  }
  if (kind === 'ssh') {
    return (
      <svg viewBox='0 0 24 24' aria-hidden='true'>
        <rect x='3' y='4' width='18' height='16' rx='2' />
        <path d='m7 9 3 3-3 3M13 15h4' />
      </svg>
    )
  }
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true'>
      <path d='M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' />
    </svg>
  )
}
