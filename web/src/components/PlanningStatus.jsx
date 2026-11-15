import { useRetryLabel } from './useRetryLabel.js'

/** Transcript tail status while the model decides what follows a tool step. */
export default function PlanningStatus() {
  const retryLabel = useRetryLabel()
  return (
    <div className='planning-status' role='status'>
      <span className='shimmer-text'>
        {retryLabel ?? 'Planning next moves'}
      </span>
    </div>
  )
}
