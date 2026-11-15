import { createContext, useContext, useMemo } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { useSubagentTabsStore } from '../stores/subagent-tabs-store.js'

/**
 * Transcript interaction callbacks for leaf tool / control cards.
 *
 * Shell / session chrome may still read the store directly; cards under the
 * message timeline should use this instead of importing useChatStore.
 *
 * Optional prop overrides on cards (e.g. `onAnswer`) win over context —
 * useful for tests / Storybook without mounting the full store.
 */

const ChatActionsContext = createContext(null)

/** Show a subagent's conversation in a tab of its own, beside the chat. */
function openSubagent(target) {
  const sessionId = useChatStore.getState().currentSessionId
  if (!sessionId || !target?.toolCallId) return
  useSubagentTabsStore.getState().open({ sessionId, ...target })
}

export function ChatActionsProvider({ children }) {
  const answerQuestion = useChatStore(s => s.answerQuestion)
  const answerCanUseTool = useChatStore(s => s.answerCanUseTool)
  const approvePlan = useChatStore(s => s.approvePlan)
  const stopTool = useChatStore(s => s.stopSubagent)

  const value = useMemo(
    () => ({
      answerQuestion,
      answerCanUseTool,
      approvePlan,
      stopTool,
      openSubagent,
    }),
    [answerQuestion, answerCanUseTool, approvePlan, stopTool],
  )

  return (
    <ChatActionsContext.Provider value={value}>
      {children}
    </ChatActionsContext.Provider>
  )
}

/**
 * @returns {{
 *   answerQuestion: (id: string, answers: object, extra?: object) => Promise<void>,
 *   answerCanUseTool: (id: string, decision: 'allow' | 'always' | 'reject') => Promise<void>,
 *   approvePlan: (requestId: string, opts: object) => Promise<void>,
 *   stopTool: (toolCallId: string) => Promise<void>,
 *   openSubagent: (target: { toolCallId: string, agentId: string | null, title: string }) => void,
 * }}
 */
export function useChatActions() {
  const ctx = useContext(ChatActionsContext)
  if (!ctx) {
    throw new Error('useChatActions must be used within ChatActionsProvider')
  }
  return ctx
}
