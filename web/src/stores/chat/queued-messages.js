/**
 * Messages typed while the agent is working.
 *
 * Each one is kept here and mirrored to the server's command queue, so the
 * running turn can hand it to the model after its next tool round. The
 * server reports that with a `queued_command` event, which moves the message
 * into the transcript. What the turn did not get to is still here when the
 * turn ends, and goes out then as an ordinary message.
 */
import { newId } from '../../lib/utils.js'
import { agentApi } from '../../lib/api/agent.js'

/** A slash command runs as a turn of its own, never inside another. */
const isSlashCommand = text => text.trimStart().startsWith('/')

/**
 * What to send once the turn is over: a leading slash command alone,
 * otherwise every message up to the next slash command, as one message.
 * @param {{ id: string, text: string }[]} queued
 * @returns {{ text: string, rest: { id: string, text: string }[] } | null}
 */
export function nextQueuedBatch(queued) {
  if (!queued || queued.length === 0) return null
  if (isSlashCommand(queued[0].text)) {
    return { text: queued[0].text, rest: queued.slice(1) }
  }
  let end = 1
  while (end < queued.length && !isSlashCommand(queued[end].text)) end++
  return {
    text: queued
      .slice(0, end)
      .map(m => m.text)
      .join('\n\n'),
    rest: queued.slice(end),
  }
}

/**
 * @param {Function} set
 * @param {Function} get
 */
export function createQueuedMessageActions(set, get) {
  const mirror = (sessionId, message) => {
    if (!sessionId || isSlashCommand(message.text)) return
    // 409 means the turn just ended; the message goes out from here then.
    agentApi
      .queueMessage(sessionId, { id: message.id, message: message.text })
      .catch(() => {})
  }
  const unmirror = (sessionId, ids) => {
    if (!sessionId) return
    for (const id of ids) {
      agentApi.removeQueuedMessage(sessionId, id).catch(() => {})
    }
  }

  return {
    /** @type {{ id: string, text: string }[]} */
    queuedMessages: [],
    /** Text to put back into the composer: `{ id, text }`, consumed once. */
    restoredDraft: null,

    /** Queue a message for the running turn; with none running, send it. */
    queueMessage: text => {
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (!trimmed || get().sessionReadOnly) return
      if (!get().isStreaming) {
        void get().sendMessage(trimmed)
        return
      }
      const message = { id: newId(), text: trimmed }
      set(s => ({ queuedMessages: [...s.queuedMessages, message] }))
      mirror(get().currentSessionId, message)
    },

    removeQueuedMessage: id => {
      if (!get().queuedMessages.some(m => m.id === id)) return
      set(s => ({ queuedMessages: s.queuedMessages.filter(m => m.id !== id) }))
      unmirror(get().currentSessionId, [id])
    },

    /**
     * The user stopped the turn: nothing queued is sent behind their back.
     * The text returns to the composer instead.
     */
    _returnQueuedMessagesToComposer: () => {
      const queued = get().queuedMessages
      if (queued.length === 0) return
      set({
        queuedMessages: [],
        restoredDraft: {
          id: newId(),
          text: queued.map(m => m.text).join('\n\n'),
        },
      })
      unmirror(
        get().currentSessionId,
        queued.map(m => m.id),
      )
    },

    consumeRestoredDraft: () => set({ restoredDraft: null }),

    /** The turn is over: send what it did not get to. */
    flushQueuedMessages: () => {
      const s = get()
      if (s.isStreaming || s.sessionLoading || s.sessionReadOnly) return
      const batch = nextQueuedBatch(s.queuedMessages)
      if (!batch) return
      set({ queuedMessages: batch.rest })
      void get().sendMessage(batch.text)
    },
  }
}
