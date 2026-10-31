/** A Worker RPC may have executed, but its acknowledgement was lost. */
export class WorkerChannelLostError extends Error {
  readonly code = 'WORKER_CHANNEL_LOST'
  readonly outcome = 'unknown'
  readonly reason = 'worker_lost'

  constructor(message = 'Worker channel lost', options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkerChannelLostError'
  }
}

export function isWorkerChannelLostError(
  value: unknown,
): value is WorkerChannelLostError {
  return (
    value instanceof WorkerChannelLostError ||
    (value instanceof Error &&
      (value.name === 'WorkerChannelLostError' ||
        (value as Error & { code?: string }).code === 'WORKER_CHANNEL_LOST'))
  )
}
