/**
 * Deterministic coverage for coding-tool registration, pooling, and execution.
 *
 * Run: npx tsx src/tests/test-coding-tools-orchestration.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '../tools.js'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  INTERACTIVE_TOOLS,
  MUTATING_TOOLS,
  PLAN_MODE_DENIED_TOOLS,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import { modeDenial } from '../core/mode-restrictions.js'
import { isToolReadOnly } from '../core/tool-definition.js'
import { ToolRegistry, defaultRegistry } from '../core/tool-registry.js'
import type {
  AnyTool,
  IEventBus,
  Session,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import type { WireEmitter } from '../core/wire-emitter.js'
import {
  answerQuestion,
  rejectQuestion,
} from '../core/brokers/question-broker.js'
import { answerPlanApproval } from '../core/brokers/plan-approval-broker.js'
import { assembleToolPool } from '../tools/assembleToolPool.js'
import { createToolSearchDefinition } from '../tools/ToolSearchTool/ToolSearchTool.js'
import { definition as todoDefinition } from '../tools/TodoWriteTool/TodoWriteTool.js'
import { definition as askDefinition } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { definition as enterPlanDefinition } from '../tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { definition as exitPlanDefinition } from '../tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { executeOneTool } from '../services/tools/tool_execution.js'
import { TOOL_INTERRUPT_RESULT } from '../utils/interrupt.js'
import { writePlan } from '../utils/plans.js'

type ExecutableTool = AnyTool & {
  execute: (input: unknown, options?: unknown) => Promise<unknown>
}

const execute = (tool: AnyTool, input: unknown = {}) =>
  (tool as ExecutableTool).execute(input, {
    toolCallId: 'direct-test',
    messages: [],
  })

function fakeTool(name: string): AnyTool {
  return { description: name } as AnyTool
}

function runtimeTool(run: () => Promise<unknown>): AnyTool {
  return { execute: run } as unknown as AnyTool
}

function fakeDefinition(
  name: string,
  options: { deferred?: boolean; readOnly?: boolean } = {},
): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    shouldDefer: options.deferred,
    isReadOnly: options.readOnly ? () => true : undefined,
    create: () => fakeTool(name),
  }
}

function session(mode: 'agent' | 'ask' | 'plan'): Session {
  return {
    id: `test-${mode}`,
    messages: [],
    createdAt: 0,
    discoveredTools: new Set(),
    permissionMode: { mode },
    agentType: null,
  }
}

function eventBus(events: Array<{ event: string; data: unknown }>): IEventBus {
  return {
    on: () => () => {},
    off: () => {},
    emit: (event, data) => events.push({ event, data }),
    scoped: () => eventBus(events),
    removeAllListeners: () => {},
  }
}

function context(
  wire: Partial<WireEmitter> = {},
  activeSession?: Session,
  events: Array<{ event: string; data: unknown }> = [],
): ToolContext {
  return {
    cwd: process.cwd(),
    session: activeSession,
    eventBus: eventBus(events),
    wire: wire as WireEmitter,
  }
}

function testConstantsAndDefaultRegistry(): void {
  assert.equal(FILE_READ_TOOL_NAME, 'Read')
  assert.equal(TOOL_SEARCH_TOOL_NAME, 'ToolSearch')
  assert.deepEqual(INTERACTIVE_TOOLS, [ASK_USER_QUESTION_TOOL_NAME])
  assert.ok(MUTATING_TOOLS.includes(TODO_WRITE_TOOL_NAME))
  assert.ok(isToolReadOnly(defaultRegistry.get(FILE_READ_TOOL_NAME)))
  for (const name of [WRITE_FILE_TOOL_NAME, BASH_TOOL_NAME, 'not-a-tool']) {
    assert.ok(
      !isToolReadOnly(defaultRegistry.get(name)),
      `${name} is not read-only`,
    )
  }
  assert.ok(PLAN_MODE_DENIED_TOOLS.includes(BASH_TOOL_NAME))

  for (const list of [
    MUTATING_TOOLS,
    INTERACTIVE_TOOLS,
    PLAN_MODE_DENIED_TOOLS,
  ]) {
    assert.equal(new Set(list).size, list.length, 'tool-name lists stay unique')
  }

  const registered = defaultRegistry.list().map(item => item.name)
  for (const name of [
    FILE_READ_TOOL_NAME,
    WRITE_FILE_TOOL_NAME,
    TODO_WRITE_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
  ]) {
    assert.ok(registered.includes(name), `${name} is registered by default`)
    assert.equal(defaultRegistry.get(name)?.name, name)
  }
  assert.equal(
    defaultRegistry.get(TOOL_SEARCH_TOOL_NAME),
    undefined,
    'ToolSearch is intentionally assembled per turn',
  )
}

function testModeRestrictionsAndAssembly(): void {
  const isReadOnly = (name: string) => isToolReadOnly(defaultRegistry.get(name))
  const allowedIn = (mode: 'agent' | 'ask' | 'plan') =>
    [
      FILE_READ_TOOL_NAME,
      WRITE_FILE_TOOL_NAME,
      BASH_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
      ENTER_PLAN_MODE_TOOL_NAME,
      EXIT_PLAN_MODE_TOOL_NAME,
    ].filter(name => !modeDenial(mode, name, isReadOnly))
  assert.deepEqual(allowedIn('ask'), [FILE_READ_TOOL_NAME])
  assert.ok(allowedIn('agent').includes(ENTER_PLAN_MODE_TOOL_NAME))
  assert.ok(!allowedIn('agent').includes(EXIT_PLAN_MODE_TOOL_NAME))
  const plan = allowedIn('plan')
  assert.ok(
    plan.includes(WRITE_FILE_TOOL_NAME),
    'plan allows writes for the plan-file guard',
  )
  assert.ok(plan.includes(ASK_USER_QUESTION_TOOL_NAME))
  assert.ok(plan.includes(EXIT_PLAN_MODE_TOOL_NAME))
  assert.ok(!plan.includes(BASH_TOOL_NAME))
  assert.ok(!plan.includes(ENTER_PLAN_MODE_TOOL_NAME))

  const registry = new ToolRegistry()
  registry.register(
    fakeDefinition(FILE_READ_TOOL_NAME, { deferred: true, readOnly: true }),
  )
  registry.register(fakeDefinition(WRITE_FILE_TOOL_NAME))
  registry.register(fakeDefinition(BASH_TOOL_NAME))
  registry.register(fakeDefinition(TODO_WRITE_TOOL_NAME, { deferred: true }))
  registry.register(fakeDefinition(ASK_USER_QUESTION_TOOL_NAME))

  const assemble = (mode: 'agent' | 'ask' | 'plan') => {
    const activeSession = session(mode)
    return assembleToolPool({
      registry,
      cwd: process.cwd(),
      session: activeSession,
      toolContext: context({}, activeSession),
      mcpTools: { mcp_lookup: fakeTool('mcp_lookup') },
      activeAgents: [],
      toolEnablement: {},
      browserConfig: { enabled: true },
    })
  }

  const agent = assemble('agent')
  assert.ok(agent.tools[WRITE_FILE_TOOL_NAME])
  assert.ok(agent.tools[BASH_TOOL_NAME])
  assert.ok(agent.tools[TOOL_SEARCH_TOOL_NAME])
  assert.ok(agent.tools[ENTER_PLAN_MODE_TOOL_NAME])
  assert.ok(agent.tools[EXIT_PLAN_MODE_TOOL_NAME])
  assert.ok(agent.deferredToolPool?.[FILE_READ_TOOL_NAME])
  assert.ok(agent.deferredToolPool?.[TODO_WRITE_TOOL_NAME])
  assert.ok(agent.deferredToolPool?.mcp_lookup)
  assert.ok(agent.dynamicDefs[TOOL_SEARCH_TOOL_NAME])

  // The prompt cache survives a mode switch only if the tools stay the same.
  for (const mode of ['ask', 'plan'] as const) {
    const pool = assemble(mode)
    assert.deepEqual(Object.keys(pool.tools), Object.keys(agent.tools), mode)
    assert.deepEqual(
      Object.keys(pool.deferredToolPool ?? {}),
      Object.keys(agent.deferredToolPool ?? {}),
      mode,
    )
  }
}

async function testToolSearch(): Promise<void> {
  const defs = Array.from({ length: 7 }, (_, index) => ({
    name: `search_${index}`,
    description: `shared lookup number ${index}`,
    isMcp: index % 2 === 0,
  }))
  const definition = createToolSearchDefinition(defs)
  const tool = definition.create(process.cwd(), context())

  const selected = (await execute(tool, {
    query: 'select:search_1,missing',
  })) as { data: { text: string; matches: Array<{ name: string }> } }
  assert.deepEqual(
    selected.data.matches.map(match => match.name),
    ['search_1'],
  )
  assert.match(selected.data.text, /Not found: missing/)

  const bareSelect = (await execute(tool, {
    query: 'search_2, search_3',
  })) as { data: { matches: Array<{ name: string }> } }
  assert.deepEqual(
    bareSelect.data.matches.map(match => match.name),
    ['search_2', 'search_3'],
  )

  const keyword = (await execute(tool, { query: 'shared lookup' })) as {
    data: { matches: unknown[] }
  }
  assert.equal(keyword.data.matches.length, 5, 'keyword results are capped')

  const empty = (await execute(tool, { query: '   ' })) as {
    data: { text: string }
  }
  assert.match(empty.data.text, /^Empty query\./)
  const none = (await execute(tool, { query: 'not-present' })) as {
    data: { text: string }
  }
  assert.match(none.data.text, /^No matches/)
}

async function testTodoWrite(): Promise<void> {
  const wireUpdates: unknown[] = []
  const events: Array<{ event: string; data: unknown }> = []
  const tool = todoDefinition.create(
    process.cwd(),
    context(
      { todoUpdate: todos => wireUpdates.push(todos) },
      undefined,
      events,
    ),
  )
  const first = (await execute(tool, {
    todos: [
      { id: 'done', content: 'Done', status: 'completed' },
      { id: 'work', content: 'Work', status: 'in_progress' },
    ],
    merge: false,
  })) as { data: { todos: Array<{ id: string }>; message: string } }
  assert.deepEqual(
    first.data.todos.map(todo => todo.id),
    ['work', 'done'],
  )
  assert.equal(
    first.data.message,
    'Updated 2 todos: 1 in_progress, 1 completed',
  )

  const merged = (await execute(tool, {
    todos: [{ id: 'next', content: 'Next', status: 'pending' }],
    merge: true,
  })) as { data: { todos: Array<{ id: string }> } }
  assert.deepEqual(
    merged.data.todos.map(todo => todo.id),
    ['work', 'next', 'done'],
  )
  assert.equal(wireUpdates.length, 2)
  assert.equal(events.filter(item => item.event === 'todo_update').length, 2)
}

async function testAskUserQuestion(): Promise<void> {
  const question = 'Choose one?'
  let requestCount = 0
  const answeredTool = askDefinition.create(
    process.cwd(),
    context({
      askUserQuestion: id => {
        requestCount++
        queueMicrotask(() => {
          assert.ok(
            answerQuestion(id, {
              answers: { [question]: 'Alpha' },
              annotations: {
                [question]: { preview: 'preview A', notes: 'note A' },
              },
            }),
          )
        })
      },
    }),
  )
  const input = {
    questions: [
      {
        question,
        header: 'Choice',
        options: [
          { label: 'Alpha', description: 'A' },
          { label: 'Beta', description: 'B' },
        ],
        multiSelect: false,
      },
    ],
  }
  const answered = (await execute(answeredTool, input)) as {
    data: { answered: boolean; text: string }
  }
  assert.equal(answered.data.answered, true)
  assert.match(answered.data.text, /selected preview:\npreview A/)
  assert.match(answered.data.text, /user notes: note A/)

  const cancelledTool = askDefinition.create(
    process.cwd(),
    context({
      askUserQuestion: id => {
        requestCount++
        queueMicrotask(() => {
          assert.ok(rejectQuestion(id, new Error('test cancellation')))
        })
      },
    }),
  )
  const cancelled = (await execute(cancelledTool, input)) as {
    data: { answered: boolean; text: string }
  }
  assert.deepEqual(cancelled.data, {
    text: 'Question was cancelled.',
    answered: false,
  })
  assert.equal(requestCount, 2)
}

async function testPlanModeTools(): Promise<void> {
  const noSession = (await execute(
    enterPlanDefinition.create(process.cwd(), context()),
  )) as { data: { message: string } }
  assert.equal(
    noSession.data.message,
    'EnterPlanMode requires an active session.',
  )

  const activeSession = session('agent')
  const modeEvents: string[] = []
  const events: Array<{ event: string; data: unknown }> = []
  const enter = enterPlanDefinition.create(
    process.cwd(),
    context(
      { modeChanged: mode => modeEvents.push(mode) },
      activeSession,
      events,
    ),
  )
  const entered = (await execute(enter)) as { data: { message: string } }
  assert.match(entered.data.message, /^Entered plan mode\./)
  assert.equal(activeSession.permissionMode.mode, 'plan')
  assert.equal(activeSession.permissionMode.preMode, 'agent')
  assert.deepEqual(modeEvents, ['plan'])
  assert.equal(events.at(-1)?.event, 'mode_changed')

  const already = (await execute(enter)) as { data: { message: string } }
  assert.equal(already.data.message, 'Already in plan mode.')

  const missingExit = await execute(
    exitPlanDefinition.create(process.cwd(), context()),
  )
  assert.equal(missingExit, 'Error: missing session context for ExitPlanMode.')
  const wrongModeSession = session('agent')
  const wrongModeExit = await execute(
    exitPlanDefinition.create(process.cwd(), context({}, wrongModeSession)),
  )
  assert.equal(
    wrongModeExit,
    'Error: ExitPlanMode is only available in plan mode.',
  )

  const planRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-plan-tool-'))
  try {
    const approvedSession = session('plan')
    writePlan(approvedSession, planRoot, '# Fixture plan\n\nImplement it.')
    const planEvents: Array<{ event: string; data: unknown }> = []
    const approved = (await execute(
      exitPlanDefinition.create(planRoot, {
        cwd: planRoot,
        session: approvedSession,
        eventBus: eventBus(planEvents),
        wire: {
          planApprovalRequest: (id: string) => {
            queueMicrotask(() => {
              assert.ok(
                answerPlanApproval(id, {
                  approved: true,
                  targetMode: 'agent',
                  editedPlan: '# Edited fixture plan\n\nImplement it now.',
                }),
              )
            })
          },
          modeChanged() {},
          planReady() {},
        } as unknown as WireEmitter,
      } as ToolContext),
    )) as {
      data: { approved: boolean; message: string; filePath: string }
      newMessages: unknown[]
    }
    assert.equal(approved.data.approved, true)
    assert.match(approved.data.message, /User has approved your plan/)
    assert.equal(approvedSession.permissionMode.mode, 'agent')
    assert.ok(approved.newMessages.length > 0)
    assert.ok(planEvents.some(item => item.event === 'plan_ready'))

    const rejectedSession = session('plan')
    writePlan(rejectedSession, planRoot, '# Rejected plan')
    const rejected = (await execute(
      exitPlanDefinition.create(planRoot, {
        cwd: planRoot,
        session: rejectedSession,
        eventBus: eventBus([]),
        wire: {
          planApprovalRequest: (id: string) => {
            queueMicrotask(() => {
              answerPlanApproval(id, {
                approved: false,
                reason: 'needs changes',
              })
            })
          },
        } as unknown as WireEmitter,
      } as ToolContext),
    )) as { data: { approved: boolean; message: string } }
    assert.equal(rejected.data.approved, false)
    assert.match(rejected.data.message, /needs changes/)
    assert.equal(rejectedSession.permissionMode.mode, 'plan')
  } finally {
    fs.rmSync(planRoot, { recursive: true, force: true })
  }
}

async function testExecuteOneTool(): Promise<void> {
  const emitted: Array<{
    tool_use_id: string
    result: string
    is_error?: boolean
    tool_use_result?: unknown
  }> = []
  const wire = {
    toolResult: (value: (typeof emitted)[number]) => emitted.push(value),
  } as unknown as WireEmitter
  const call = (toolName: string, toolCallId = toolName) => ({
    toolCallId,
    toolName,
    input: {},
  })

  const plain = await executeOneTool(
    call('plain'),
    {
      plain: runtimeTool(async () => 'ok'),
    },
    wire,
  )
  assert.equal(plain.result, 'ok')
  assert.equal(plain.isError, undefined)

  const structured = await executeOneTool(
    call('structured'),
    {
      structured: runtimeTool(async () => ({
        result: 'structured ok',
        followUpMessages: [{ role: 'user', content: 'follow up' }],
      })),
    },
    wire,
  )
  assert.equal(structured.result, 'structured ok')
  assert.equal(structured.followUpMessages?.length, 1)

  const dualDefinition: ToolDefinition = {
    name: 'dual',
    description: 'dual',
    outputSchema: {
      safeParse: value => ({ success: true, data: value }),
    },
    mapToolResultToToolResultBlockParam: output => ({
      tool_use_id: 'dual',
      type: 'tool_result',
      content: `mapped:${String((output as { value: number }).value)}`,
    }),
    create: () => fakeTool('dual'),
  }
  const dual = await executeOneTool(
    call('dual'),
    {
      dual: runtimeTool(async () => ({ data: { value: 7 } })),
    },
    wire,
    undefined,
    name => (name === 'dual' ? dualDefinition : undefined),
  )
  assert.equal(dual.result, 'mapped:7')
  assert.deepEqual(dual.toolUseResult, { value: 7 })

  const stringError = await executeOneTool(
    call('stringError'),
    {
      stringError: runtimeTool(async () => 'Error: expected'),
    },
    wire,
  )
  assert.equal(stringError.isError, true)

  const unknown = await executeOneTool(call('missing'), {}, wire)
  assert.equal(unknown.result, 'Error: Unknown tool: missing')
  assert.equal(
    unknown.isError,
    undefined,
    'unknown-tool compatibility shape currently omits isError',
  )

  const thrown = await executeOneTool(
    call('throws'),
    {
      throws: runtimeTool(async () => {
        throw new Error('boom')
      }),
    },
    wire,
  )
  assert.equal(thrown.isError, true)
  assert.match(thrown.result, /^Error: .*boom/)

  const preAborted = new AbortController()
  preAborted.abort()
  let invoked = false
  const abortedBeforeRun = await executeOneTool(
    call('neverRuns'),
    {
      neverRuns: runtimeTool(async () => {
        invoked = true
        return 'unexpected'
      }),
    },
    wire,
    undefined,
    undefined,
    preAborted.signal,
  )
  assert.equal(invoked, false)
  assert.equal(abortedBeforeRun.result, TOOL_INTERRUPT_RESULT)
  assert.equal(abortedBeforeRun.isError, true)

  const abortError = await executeOneTool(
    call('abortError'),
    {
      abortError: runtimeTool(async () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      }),
    },
    wire,
  )
  assert.equal(abortError.result, TOOL_INTERRUPT_RESULT)
  assert.equal(abortError.isError, true)
  assert.ok(emitted.some(item => item.is_error === true))
}

testConstantsAndDefaultRegistry()
testModeRestrictionsAndAssembly()
await testToolSearch()
await testTodoWrite()
await testAskUserQuestion()
await testPlanModeTools()
await testExecuteOneTool()
console.log('coding tools orchestration tests passed')
