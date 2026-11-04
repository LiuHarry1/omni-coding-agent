/** Transcript tail status while the model decides what follows a tool step. */
export default function PlanningStatus() {
  return (
    <div className='planning-status' role='status'>
      <span className='shimmer-text'>Working on next step</span>
    </div>
  )
}
