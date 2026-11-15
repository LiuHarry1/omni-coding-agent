/**
 * Turn-host memory side-paths (session-memory + auto-memory).
 * Kept out of runAgent so the loop stays a step machine.
 */
import type {
  AgentLifecycleSnapshot,
  AutoMemoryConfig,
  MemoryVocabulary,
  RunAgentFn,
  SessionMemoryConfig,
} from '../core/types.js'
import type { IProvider } from '../services/llm/types.js'
import { createCacheSafeParams } from '../core/forked-agent.js'
import { extractSessionMemoryInBackground } from '../services/session-memory/index.js'
import { extractAutoMemoriesInBackground } from '../services/auto-memory/index.js'
import {
  getRequestScope,
  runWithRequestScope,
} from '../utils/workspace/request-scope.js'
import { getActiveModelMessages } from '../services/compact/index.js'

export function createMemoryLifecycleHooks(opts: {
  sessionMemory?: SessionMemoryConfig
  sessionMemoryModelId?: string
  sessionMemoryProvider?: IProvider
  autoMemory?: AutoMemoryConfig
  autoMemoryModelId?: string
  autoMemoryProvider?: IProvider
  runAgent: RunAgentFn
  /** Explicit extract write target from MemoryBinding.writeDir. */
  memoryDir?: string
  extractEnabled?: boolean
  vocabulary?: MemoryVocabulary
}) {
  const {
    sessionMemory,
    sessionMemoryModelId,
    sessionMemoryProvider,
    autoMemory,
    autoMemoryModelId,
    autoMemoryProvider,
    runAgent,
    memoryDir,
    extractEnabled,
    vocabulary,
  } = opts

  return {
    /** After each completed step — fire-and-forget session-memory extract. */
    onAfterStep(snap: AgentLifecycleSnapshot): void {
      if (
        !snap.sessionId ||
        !sessionMemory?.enabled ||
        (sessionMemory.cacheSafe === false && !sessionMemoryModelId)
      ) {
        return
      }
      const messages = getActiveModelMessages(snap.messages, snap.sessionId)
      const tools = { ...snap.tools }
      const cacheSafeParams =
        sessionMemory.cacheSafe !== false
          ? createCacheSafeParams({
              systemPrompt: snap.systemPrompt,
              tools,
              provider: snap.provider,
              model: snap.model,
              messages,
            })
          : undefined
      // Capture scope now; re-enter ALS so background extract keeps tenant
      // home/cwd after the HTTP request callback returns.
      const scope = getRequestScope()
      const reenter = () => {
        extractSessionMemoryInBackground({
          messages,
          sessionId: snap.sessionId!,
          provider: sessionMemoryProvider ?? snap.provider,
          modelId: sessionMemoryModelId ?? snap.model,
          config: sessionMemory,
          runAgent,
          cwd: snap.cwd ?? process.cwd(),
          cacheSafeParams,
        })
      }
      if (scope) runWithRequestScope(scope, reenter)
      else reenter()
    },

    /** Successful turn finalization — fire-and-forget auto-memory extract. */
    onTurnEnd(snap: AgentLifecycleSnapshot): void {
      if (
        !snap.sessionId ||
        !autoMemory?.enabled ||
        extractEnabled === false ||
        !memoryDir ||
        (autoMemory.cacheSafe === false && !autoMemoryModelId)
      ) {
        return
      }
      const messages = getActiveModelMessages(snap.messages, snap.sessionId)
      const tools = { ...snap.tools }
      const cacheSafeParams =
        autoMemory.cacheSafe !== false
          ? createCacheSafeParams({
              systemPrompt: snap.systemPrompt,
              tools,
              provider: snap.provider,
              model: snap.model,
              messages,
            })
          : undefined
      const scope = getRequestScope()
      const reenter = () => {
        extractAutoMemoriesInBackground({
          messages,
          sessionId: snap.sessionId!,
          provider: autoMemoryProvider ?? snap.provider,
          modelId: autoMemoryModelId ?? snap.model,
          config: autoMemory,
          runAgent,
          cwd: snap.cwd ?? process.cwd(),
          cacheSafeParams,
          trustedDirectory: autoMemory.directory,
          memoryDir,
          vocabulary,
        })
      }
      if (scope) runWithRequestScope(scope, reenter)
      else reenter()
    },
  }
}
