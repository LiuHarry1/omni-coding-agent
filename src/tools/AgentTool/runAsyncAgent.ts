/**
 * The life of a background agent, from launch to its notification
 * (Claude Code `tools/AgentTool/agentToolUtils.ts` runAsyncAgentLifecycle).
 */
import { appendFileSync } from 'fs'
import type { IEventBus, Message } from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import {
  completeAsyncAgent,
  enqueueAgentNotification,
  failAsyncAgent,
  killAsyncAgent,
  updateAsyncAgentProgress,
  type AgentProgress,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  extractPartialResult,
  SUBAGENT_NO_OUTPUT_MARKER,
} from './finalizeAgentTool.js'

const ACTIVITY_MAX_CHARS = 120

/** Input fields that say what a tool call is about, most telling first. */
const ACTIVITY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
]

/** One line for a tool call: `Read src/core/query.ts`. */
export function describeToolActivity(toolName: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  for (const key of ACTIVITY_KEYS) {
    const value = record[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const line = value.trim().split('\n')[0]!
    const detail =
      line.length > ACTIVITY_MAX_CHARS
        ? `${line.slice(0, ACTIVITY_MAX_CHARS - 1)}…`
        : line
    return `${toolName} ${detail}`
  }
  return toolName
}

type TranscriptLines = { text: string; activities: string[] }

/**
 * What the agent said and did in these messages, as the plain text kept in
 * its output file: its own words, and one line per tool call.
 */
export function renderAgentProgress(
  messages: readonly Message[],
): TranscriptLines {
  const lines: string[] = []
  const activities: string[] = []
  for (const message of messages) {
    if (!isRoleMessage(message) || message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type === 'text' && part.text.trim()) {
        lines.push(part.text.trim())
      } else if (part.type === 'tool-call') {
        const activity = describeToolActivity(part.toolName, part.input)
        activities.push(activity)
        lines.push(`[tool] ${activity}`)
      }
    }
  }
  return { text: lines.length ? `${lines.join('\n')}\n` : '', activities }
}

function appendToOutputFile(outputFile: string, content: string): void {
  if (!content) return
  try {
    appendFileSync(outputFile, content, 'utf8')
  } catch (err) {
    console.warn(
      `[agent:background] could not write ${outputFile}: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export type AsyncAgentRun = {
  task: LocalAgentTaskState
  /** The bus the agent's model usage is reported on. */
  eventBus: IEventBus
  /** The agent's conversation; the run appends to it. */
  messages: Message[]
  /** Runs the agent to its final text. Call `onStepCommitted` after every step. */
  run: (
    onStepCommitted: (messages: readonly Message[]) => void,
  ) => Promise<string>
  /**
   * Tidy the agent's git worktree once it has stopped. Answers with the
   * worktree when it was kept, for the notification to say where the
   * changes are.
   */
  finishWorktree?: () => Promise<{ path: string; branch: string } | undefined>
  /** Release what the agent held. Runs after the notification is queued. */
  cleanup?: () => void | Promise<void>
}

/**
 * Run a registered background agent to its end and report it. Never throws:
 * nobody is waiting on the promise.
 */
export async function runAsyncAgentLifecycle(
  input: AsyncAgentRun,
): Promise<void> {
  const { task, eventBus, messages } = input
  const { sessionId, id: taskId, description, toolUseId } = task
  const abortSignal = task.abortController?.signal
  const startTime = Date.now()

  // The context it works in now plus everything it has written: the last
  // request's input already contains the earlier ones.
  const tokens = { latestInput: 0, cumulativeOutput: 0 }
  const progress: AgentProgress = { toolUseCount: 0, tokenCount: 0 }
  const unsubUsage = eventBus.on('usage', data => {
    const usage = data as { inputTokens?: number; outputTokens?: number }
    tokens.latestInput = usage.inputTokens ?? tokens.latestInput
    tokens.cumulativeOutput += usage.outputTokens ?? 0
    progress.tokenCount = tokens.latestInput + tokens.cumulativeOutput
  })

  let written = 0
  const record = (current: readonly Message[]) => {
    const fresh = renderAgentProgress(current.slice(written))
    written = current.length
    appendToOutputFile(task.outputFile, fresh.text)
    progress.toolUseCount += fresh.activities.length
    const lastActivity = fresh.activities.at(-1)
    if (lastActivity) progress.lastActivity = lastActivity
    updateAsyncAgentProgress(sessionId, taskId, { ...progress })
  }

  // After the task's status has changed, so a TaskOutput call waiting on it
  // is not held up by git.
  const keptWorktree = async () => {
    try {
      return await input.finishWorktree?.()
    } catch (err) {
      console.warn(
        `[agent:background] worktree of ${taskId} not tidied: ${err instanceof Error ? err.message : err}`,
      )
      return undefined
    }
  }

  appendToOutputFile(
    task.outputFile,
    `Agent (${task.agentType}): ${description}\n\n`,
  )

  try {
    const text = await input.run(record)
    record(messages)
    if (abortSignal?.aborted) {
      throw Object.assign(new Error('Agent stopped'), { name: 'AbortError' })
    }

    const finalMessage =
      (typeof text === 'string' ? text.trim() : '') ||
      extractPartialResult(messages) ||
      SUBAGENT_NO_OUTPUT_MARKER

    // Completed first, so a TaskOutput call waiting on the task returns
    // before the notification is put together.
    completeAsyncAgent(sessionId, taskId, finalMessage)
    appendToOutputFile(task.outputFile, '\n[completed]\n')
    enqueueAgentNotification({
      sessionId,
      taskId,
      description,
      status: 'completed',
      finalMessage,
      usage: {
        totalTokens: progress.tokenCount,
        toolUses: progress.toolUseCount,
        durationMs: Date.now() - startTime,
      },
      toolUseId,
      worktree: await keptWorktree(),
    })
  } catch (error) {
    record(messages)
    if (abortSignal?.aborted || isAbortError(error)) {
      // A no-op for the status when TaskStop got there first, but only this
      // handler has the messages: the notification carries what the agent
      // had found.
      const partialResult = extractPartialResult(messages)
      killAsyncAgent(sessionId, taskId, partialResult)
      appendToOutputFile(task.outputFile, '\n[stopped]\n')
      enqueueAgentNotification({
        sessionId,
        taskId,
        description,
        status: 'killed',
        finalMessage: partialResult,
        toolUseId,
        worktree: await keptWorktree(),
      })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    failAsyncAgent(sessionId, taskId, message)
    appendToOutputFile(task.outputFile, `\n[failed] ${message}\n`)
    enqueueAgentNotification({
      sessionId,
      taskId,
      description,
      status: 'failed',
      error: message,
      toolUseId,
      worktree: await keptWorktree(),
    })
  } finally {
    unsubUsage()
    try {
      await input.cleanup?.()
    } catch (err) {
      console.warn(
        `[agent:background] cleanup of ${taskId} failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

/**
 * What the Agent tool answers when it has launched an agent in the
 * background (Claude Code AgentTool `async_launched` result).
 */
export function asyncAgentLaunchedText(input: {
  agentId: string
  outputFile: string
  canReadOutputFile: boolean
}): string {
  const prefix = `Async agent launched successfully.\nagentId: ${input.agentId} (internal ID - do not mention to user. Use TaskStop with this ID to stop the agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`
  const instructions = input.canReadOutputFile
    ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: ${input.outputFile}\nIf asked, you can check progress before completion by using Read or Bash tail on the output file.`
    : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`
  return `${prefix}\n${instructions}`
}
