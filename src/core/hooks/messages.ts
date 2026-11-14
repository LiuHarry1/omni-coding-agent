import { randomUUID } from 'crypto'
import type { Attachment, AttachmentMessage } from '../types.js'
import type { AggregatedHookResult } from './types.js'

function attachmentMessage(attachment: Attachment): AttachmentMessage {
  return {
    type: 'attachment',
    attachment,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isMeta: true,
  }
}

export function hookStoppedMessage(result: AggregatedHookResult): string {
  return result.stopReason || 'Execution stopped by hook'
}

/**
 * What a hook result adds to the transcript for the model to read:
 * its blocking errors (unless the caller reports them another way), the
 * context it supplied, and a note when it stopped the turn.
 */
export function hookResultMessages(
  result: AggregatedHookResult,
  options: { blockingErrors?: boolean; outputs?: boolean } = {},
): AttachmentMessage[] {
  const messages: AttachmentMessage[] = []
  if (options.blockingErrors) {
    for (const blockingError of result.blockingErrors) {
      messages.push(
        attachmentMessage({
          type: 'hook_blocking_error',
          hookName: result.hookName,
          blockingError,
        }),
      )
    }
  }
  if (options.outputs) {
    for (const content of result.outputs) {
      messages.push(
        attachmentMessage({
          type: 'hook_success',
          hookName: result.hookName,
          content,
        }),
      )
    }
  }
  if (result.additionalContexts.length > 0) {
    messages.push(
      attachmentMessage({
        type: 'hook_additional_context',
        hookName: result.hookName,
        content: result.additionalContexts,
      }),
    )
  }
  if (result.preventContinuation) {
    messages.push(
      attachmentMessage({
        type: 'hook_stopped_continuation',
        hookName: result.hookName,
        message: hookStoppedMessage(result),
      }),
    )
  }
  return messages
}
