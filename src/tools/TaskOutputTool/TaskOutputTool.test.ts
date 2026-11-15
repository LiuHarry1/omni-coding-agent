import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSessionLocation } from '../../session/paths.js'
import type { AnyTool, ToolContext } from '../../core/types.js'
import {
  completeAsyncAgent,
  failAsyncAgent,
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { resetCommandQueue } from '../../utils/messageQueueManager.js'
import { runWithRequestScope } from '../../utils/workspace/request-scope.js'
import { _resetTaskOutputDirForTest } from '../../utils/task/diskOutput.js'
import { clearSessionTasks } from '../../utils/task/framework.js'
import { definition, type TaskOutputToolResult } from './TaskOutputTool.js'

type ExecutableTool = AnyTool & {
  execute: (
    input: unknown,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<{ data: TaskOutputToolResult } | string>
}

let agentHome: string
let sessionId: string

const inScope = <T>(fn: () => T): T =>
  runWithRequestScope({ agentHome, cwd: '/workspace' }, fn)

const taskOutput = (
  args: Record<string, unknown>,
  options?: { abortSignal?: AbortSignal },
) =>
  inScope(() =>
    (
      definition.create('/workspace', {
        sessionId,
      } as unknown as ToolContext) as ExecutableTool
    ).execute(args, options),
  )

const launch = () =>
  inScope(() =>
    registerAsyncAgent({
      sessionId,
      description: 'Audit the routes',
      prompt: 'List every HTTP route.',
      agentType: 'Explore',
    }),
  )

beforeEach(() => {
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-task-output-'))
  sessionId = `task-output-${Date.now()}-${Math.random()}`
  registerSessionLocation(sessionId, { projectKey: 'project', agentHome })
})

afterEach(() => {
  clearSessionTasks(sessionId)
  resetCommandQueue()
  _resetTaskOutputDirForTest()
  fs.rmSync(agentHome, { recursive: true, force: true })
})

describe('TaskOutput on a background agent', () => {
  it('shows what the agent has done so far while it is still working', async () => {
    const task = launch()
    fs.appendFileSync(task.outputFile, '[tool] Read src/server/router.ts\n')

    const result = (await taskOutput({ task_id: task.id, block: false })) as {
      data: TaskOutputToolResult
    }

    expect(result.data).toMatchObject({
      task_id: task.id,
      retrieval_status: 'not_ready',
      task_status: 'running',
    })
    expect(result.data.output).toContain('[tool] Read src/server/router.ts')
  })

  it('answers with the report once the agent is done, not with its log', async () => {
    const task = launch()
    fs.appendFileSync(task.outputFile, '[tool] Read src/server/router.ts\n')
    completeAsyncAgent(sessionId, task.id, 'Found 12 routes.')

    const result = (await taskOutput({ task_id: task.id })) as {
      data: TaskOutputToolResult
    }

    expect(result.data).toMatchObject({
      retrieval_status: 'success',
      task_status: 'completed',
    })
    expect(result.data.output).toContain('Found 12 routes.')
    expect(result.data.output).not.toContain('[tool]')
  })

  it('returns as soon as a waited-for agent finishes', async () => {
    const task = launch()
    setTimeout(() => completeAsyncAgent(sessionId, task.id, 'Done.'), 150)

    const result = (await taskOutput({ task_id: task.id, timeout: 5_000 })) as {
      data: TaskOutputToolResult
    }

    expect(result.data.retrieval_status).toBe('success')
    expect(result.data.output).toContain('Done.')
  })

  it('stops waiting as soon as the caller is stopped', async () => {
    const task = launch()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 100)
    const started = Date.now()

    await expect(
      taskOutput(
        { task_id: task.id, timeout: 30_000 },
        { abortSignal: abort.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('shows the error of an agent that failed', async () => {
    const task = launch()
    failAsyncAgent(sessionId, task.id, 'model overloaded')

    const result = (await taskOutput({ task_id: task.id })) as {
      data: TaskOutputToolResult
    }

    expect(result.data.task_status).toBe('failed')
    expect(result.data.output).toContain('Error: model overloaded')
  })

  it('rejects an id that is not a task', async () => {
    await expect(taskOutput({ task_id: 'a00000000' })).resolves.toBe(
      'Error: no background task with id a00000000',
    )
  })
})
