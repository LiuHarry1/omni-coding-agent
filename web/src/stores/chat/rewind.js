/**
 * Going back in the conversation: rewind to before one of the user's
 * messages (optionally restoring the files the agent changed since), or fork
 * a new session from there. Either way the message's text returns to the
 * composer for editing.
 */
import { newId } from '../../lib/utils.js'
import { agentApi } from '../../lib/api/agent.js'
import { messagesToBubbles } from '../../lib/bubbles/messages-to-bubbles.js'
import { sanitizeMessagesForUi } from '../../lib/sanitize-tool-ui.js'
import { refreshIdeAfterAgentTurn } from './ide-bridge.js'

/**
 * @param {Function} set
 * @param {Function} get
 */
export function createRewindActions(set, get) {
  const draft = text => (text ? { id: newId(), text } : null)

  return {
    previewRewind: messageId => {
      const id = get().currentSessionId
      if (!id) return Promise.reject(new Error('No session'))
      return agentApi.previewRewind(id, messageId)
    },

    rewindTo: async (messageId, { restoreFiles = false } = {}) => {
      const id = get().currentSessionId
      if (!id || get().isStreaming) return
      const data = await agentApi.rewindSession(id, {
        messageId,
        restoreFiles,
      })
      if (get().currentSessionId !== id) return
      const next = messagesToBubbles(sanitizeMessagesForUi(data.messages ?? []))
      set({
        bubbleOrder: next.bubbleOrder,
        bubblesById: next.bubblesById,
        notice: null,
        restoredDraft: draft(data.prompt),
      })
      if (data.files) refreshIdeAfterAgentTurn()
      return data
    },

    forkFrom: async messageId => {
      const id = get().currentSessionId
      if (!id || get().isStreaming) return
      const data = await agentApi.forkSession(id, messageId)
      await get().refreshSessions()
      await get().switchSession(data.session_id)
      set({ restoredDraft: draft(data.prompt) })
      return data
    },
  }
}
