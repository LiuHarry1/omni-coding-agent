import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ToolContext } from '../core/types.js'
import { definition as bashDefinition } from '../tools/BashTool/BashTool.js'
import { definition as powershellDefinition } from '../tools/PowerShellTool/PowerShellTool.js'
import { definition as lspDefinition } from '../tools/LSPTool/LSPTool.js'
import { definition as taskOutputDefinition } from '../tools/TaskOutputTool/TaskOutputTool.js'
import { definition as taskStopDefinition } from '../tools/TaskStopTool/TaskStopTool.js'
import { definition as webSearchDefinition } from '../tools/WebSearchTool/WebSearchTool.js'
import { createFilesystemPermissionContext } from '../utils/permissions/filesystem.js'
import { computeProjectKey, registerSessionLocation } from '../session/paths.js'
import { resolveAgentHome } from '../utils/workspace/request-scope.js'

type ExecutableTool = {
  execute: (
    input: Record<string, unknown>,
    options?: { toolCallId?: string; abortSignal?: AbortSignal },
  ) => Promise<unknown>
}

const root = await mkdtemp(path.join(tmpdir(), 'coding-tools-platform-'))
let webServer: http.Server | undefined
try {
  await writeFile(path.join(root, 'fixture.ts'), 'export const value = 1\n')

  const execution = {
    exec: async (command: string) => {
      if (command === 'throw') throw new Error('worker unavailable')
      return {
        stdout:
          command === 'fail' || command === 'timeout' ? '' : 'worker-ok\n',
        stderr: command === 'fail' ? 'worker-failed\n' : '',
        code: command === 'timeout' ? null : command === 'fail' ? 7 : 0,
        cwdAfter: root,
        timedOut: command === 'timeout',
      }
    },
  }
  const context = {
    sessionId: `coding-tools-${Date.now()}`,
    execution,
    permissionContext: createFilesystemPermissionContext(root, {
      mode: 'dontAsk',
    }),
    wire: {
      toolResult() {},
      processOutput() {},
    },
  } as unknown as ToolContext

  for (const definition of [bashDefinition, powershellDefinition]) {
    const shell = definition.create(root, context) as unknown as ExecutableTool
    const success = (await shell.execute({ command: 'ok' })) as {
      data: { stdout: string; exitCode: number; outcome: string }
    }
    assert.equal(success.data.stdout, 'worker-ok\n')
    assert.equal(success.data.exitCode, 0)
    assert.equal(success.data.outcome, 'success')

    const failure = (await shell.execute({ command: 'fail' })) as {
      data: { stderr: string; exitCode: number; outcome: string }
    }
    assert.equal(failure.data.stderr, 'worker-failed\n')
    assert.equal(failure.data.exitCode, 7)
    assert.equal(failure.data.outcome, 'failure')

    const timedOut = (await shell.execute({
      command: 'timeout',
      timeout: 250,
    })) as { data: { interrupted: boolean; outcome: string; text: string } }
    assert.equal(timedOut.data.interrupted, true)
    assert.equal(timedOut.data.outcome, 'timeout')
    assert.match(timedOut.data.text, /timed out after 0.3s/)

    const spawnError = (await shell.execute({ command: 'throw' })) as {
      data: { outcome: string; stderr: string }
    }
    assert.equal(spawnError.data.outcome, 'spawnError')
    assert.match(spawnError.data.stderr, /worker unavailable/)
    assert.match(
      String(await shell.execute({ command: 'ok', stdin: 'input' })),
      /stdin piping is not supported over Worker/,
    )

    const controller = new AbortController()
    controller.abort()
    const aborted = (await shell.execute(
      { command: 'never' },
      { abortSignal: controller.signal },
    )) as { data: { interrupted: boolean; outcome: string } }
    assert.equal(aborted.data.interrupted, true)
    assert.equal(aborted.data.outcome, 'aborted')
    assert.equal(
      await shell.execute({ command: ' ' }),
      'Error: provide `command` to run.',
    )
  }

  const backgroundSessionId = `coding-tools-background-${Date.now()}`
  registerSessionLocation(backgroundSessionId, {
    projectKey: computeProjectKey(undefined, root),
    agentHome: resolveAgentHome(),
  })
  const localTaskContext = {
    sessionId: backgroundSessionId,
    wire: {
      toolResult() {},
      processOutput() {},
    },
  } as unknown as ToolContext
  const localBash = bashDefinition.create(
    root,
    localTaskContext,
  ) as unknown as ExecutableTool
  const localSuccess = (await localBash.execute({
    command: "printf 'local-ok\\n'",
  })) as { data: { stdout: string; outcome: string } }
  assert.equal(localSuccess.data.outcome, 'success')
  assert.match(localSuccess.data.stdout, /local-ok/)
  const localFailure = (await localBash.execute({ command: 'false' })) as {
    data: { exitCode: number; outcome: string; text: string }
  }
  assert.equal(localFailure.data.exitCode, 1)
  assert.equal(localFailure.data.outcome, 'failure')
  assert.match(localFailure.data.text, /exit code: 1/)
  const localTimeout = (await localBash.execute({
    command: 'sleep 2',
    timeout: 100,
  })) as { data: { interrupted: boolean; outcome: string } }
  assert.equal(localTimeout.data.interrupted, true)
  assert.equal(localTimeout.data.outcome, 'timeout')

  const refusedRemote = bashDefinition.create(root, {
    session: {
      workspace: { environmentId: 'ssh-without-worker' },
    },
    wire: localTaskContext.wire,
  } as unknown as ToolContext) as unknown as ExecutableTool
  const refused = (await refusedRemote.execute({ command: 'pwd' })) as {
    data: { outcome: string; text: string }
  }
  assert.equal(refused.data.outcome, 'spawnError')
  assert.match(refused.data.text, /refusing local shell fallback/)

  const background = (await localBash.execute(
    {
      command: "printf 'background-ok\\n'",
      description: 'Emit background fixture',
      run_in_background: true,
    },
    { toolCallId: 'background-fixture' },
  )) as { data: { backgroundTaskId: string; backgrounded: boolean } }
  assert.equal(background.data.backgrounded, true, JSON.stringify(background))
  assert.ok(background.data.backgroundTaskId)
  const localTaskOutput = taskOutputDefinition.create(
    root,
    localTaskContext,
  ) as unknown as ExecutableTool
  const completedOutput = (await localTaskOutput.execute({
    task_id: background.data.backgroundTaskId,
    block: true,
    timeout: 10_000,
  })) as {
    data: { retrieval_status: string; output: string; task_status: string }
  }
  assert.equal(completedOutput.data.retrieval_status, 'success')
  assert.match(completedOutput.data.output, /background-ok/)

  const longBackground = (await localBash.execute(
    {
      command: 'sleep 30',
      description: 'Wait for stop fixture',
      run_in_background: true,
    },
    { toolCallId: 'stop-fixture' },
  )) as { data: { backgroundTaskId: string } }
  const localTaskStop = taskStopDefinition.create(
    root,
    localTaskContext,
  ) as unknown as ExecutableTool
  const stopped = (await localTaskStop.execute({
    task_id: longBackground.data.backgroundTaskId,
  })) as { data: { stopped: boolean; task_id: string } }
  assert.equal(stopped.data.stopped, true)
  assert.equal(stopped.data.task_id, longBackground.data.backgroundTaskId)
  await new Promise(resolve => setTimeout(resolve, 500))

  const lsp = lspDefinition.create(root, context) as unknown as ExecutableTool
  assert.match(
    String(
      await lsp.execute({
        operation: 'go_to_definition',
        file_path: 'fixture.ts',
      }),
    ),
    /line and character are required/,
  )
  assert.equal(
    await lsp.execute({
      operation: 'document_symbol',
      file_path: 'fixture.ts',
    }),
    'No LSP servers configured. Add lspServers to .ai-agent/settings.json.',
  )
  assert.match(
    String(
      await lsp.execute({
        operation: 'document_symbol',
        file_path: '../outside.ts',
      }),
    ),
    /^Error:/,
  )

  let remoteFileOpen = false
  const location = {
    uri: 'file:///remote/ws/fixture.ts',
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 7 },
    },
  }
  const remoteLspContext = {
    wire: context.wire,
    execution: {
      kind: 'worker',
      environmentId: 'ssh-fixture',
      configureLsp() {},
      resolve: (cwd: string, value: string) => `${cwd}/${value}`,
      assertInWorkspace() {},
      lspHasServerForFile: async () => true,
      lspIsFileOpen: async () => remoteFileOpen,
      readText: async () => 'export const value = 1\n',
      lspOpenFile: async () => {
        remoteFileOpen = true
      },
      lspRequest: async (_file: string, method: string): Promise<unknown> => {
        if (method === 'textDocument/definition') return location
        if (method === 'textDocument/references') return [location, location]
        if (method === 'textDocument/hover') {
          return { contents: { kind: 'markdown', value: '`value: number`' } }
        }
        if (method === 'textDocument/documentSymbol') {
          return [
            {
              name: 'value',
              kind: 13,
              range: location.range,
              selectionRange: location.range,
            },
          ]
        }
        if (method === 'workspace/symbol') {
          return [{ name: 'value', kind: 13, location }]
        }
        if (method === 'textDocument/implementation') return null
        throw new Error(`unexpected method ${method}`)
      },
    },
  } as unknown as ToolContext
  const remoteLsp = lspDefinition.create(
    '/remote/ws',
    remoteLspContext,
  ) as unknown as ExecutableTool
  const lspCases = [
    ['go_to_definition', /Found 1 definition/],
    ['find_references', /Found 2 references/],
    ['hover', /value: number/],
    ['document_symbol', /Document symbols:/],
    ['workspace_symbol', /Found 1 workspace symbol/],
    ['go_to_implementation', /No definitions found/],
  ] as const
  for (const [operation, expected] of lspCases) {
    const raw = (await remoteLsp.execute({
      operation,
      file_path: 'fixture.ts',
      line: 1,
      character: 1,
      query: 'value',
    })) as { data: { text: string; operation: string } }
    assert.equal(raw.data.operation, operation)
    assert.match(raw.data.text, expected)
  }

  const taskOutput = taskOutputDefinition.create(
    root,
    context,
  ) as unknown as ExecutableTool
  assert.equal(
    await taskOutput.execute({ task_id: 'missing-task', block: false }),
    'Error: no background task with id missing-task',
  )

  const taskStop = taskStopDefinition.create(
    root,
    context,
  ) as unknown as ExecutableTool
  assert.equal(await taskStop.execute({}), 'Error: provide task_id')
  assert.match(
    String(await taskStop.execute({ shell_id: 'missing-task' })),
    /^Error:/,
  )

  const mappedSearch = webSearchDefinition.mapToolResultToToolResultBlockParam!(
    { query: 'agent tools', results: [] },
    'search-1',
  )
  assert.match(String(mappedSearch.content), /No results found/)
  assert.match(String(mappedSearch.content), /MUST include the sources/)
  assert.ok(
    webSearchDefinition.outputSchema!.safeParse({
      query: 'agent tools',
      results: [],
    }).success,
  )

  webServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const query = url.searchParams.get('q')
    const wantsJson = url.searchParams.get('format') === 'json'
    if (query === 'html' && wantsJson) {
      res.writeHead(403)
      res.end('json disabled')
      return
    }
    if (query === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        '<article><h3><a href="https://example.test/html">HTML result</a></h3><p class="content">fallback snippet</p><div class="engines"><span>fixture</span></div></article>',
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        query,
        number_of_results: query === 'empty' ? 0 : 1,
        answers: query === 'empty' ? [] : ['fixture answer'],
        suggestions: ['next query'],
        results:
          query === 'empty'
            ? []
            : [
                {
                  title: 'JSON result',
                  url: 'https://example.test/json',
                  content: 'json snippet',
                  engine: 'fixture',
                },
              ],
      }),
    )
  })
  await new Promise<void>(resolve => webServer!.listen(0, '127.0.0.1', resolve))
  const port = (webServer.address() as AddressInfo).port
  const previousProvider = process.env.WEB_SEARCH_PROVIDER
  const previousUrl = process.env.SEARXNG_URL
  process.env.WEB_SEARCH_PROVIDER = 'searxng'
  process.env.SEARXNG_URL = `http://127.0.0.1:${port}`
  try {
    const webSearch = webSearchDefinition.create(
      root,
      context,
    ) as unknown as ExecutableTool
    const jsonSearch = (await webSearch.execute({
      query: 'json',
      max_results: 3,
      language: 'en',
      categories: 'it',
      time_range: 'week',
    })) as { data: { format: string; results: unknown[] } }
    assert.equal(jsonSearch.data.format, 'json')
    assert.equal(jsonSearch.data.results.length, 1)

    const emptySearch = (await webSearch.execute({
      query: 'empty',
    })) as { data: { warning: string; results: unknown[] } }
    assert.equal(emptySearch.data.results.length, 0)
    assert.match(emptySearch.data.warning, /zero results/i)

    const htmlSearch = (await webSearch.execute({
      query: 'html',
    })) as { data: { format: string; results: unknown[]; note: string } }
    assert.equal(htmlSearch.data.format, 'html-fallback')
    assert.equal(htmlSearch.data.results.length, 1)
    assert.match(htmlSearch.data.note, /JSON returned HTTP 403/)

    const originalFetch = globalThis.fetch
    process.env.WEB_SEARCH_PROVIDER = 'exa'
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: { query: string } }
      }
      const query = body.params.arguments.query
      if (query === 'http-error') {
        return new Response('nope', { status: 503 })
      }
      const text =
        query === 'markdown'
          ? '[Markdown result](https://example.test/markdown)'
          : query === 'raw'
            ? 'Useful answer without links'
            : [
                'Title: Exa result',
                'URL: https://example.test/exa',
                'Published: 2026-09-29',
                'Highlights:',
                'A useful fixture result.',
              ].join('\n')
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text }] },
      })
      return new Response(
        query === 'markdown' ? `data: ${payload}\n\n` : payload,
        { status: 200 },
      )
    }
    try {
      const exaSearch = webSearchDefinition.create(
        root,
        context,
      ) as unknown as ExecutableTool
      const exaBlocks = (await exaSearch.execute({
        query: 'blocks',
        max_results: 2,
      })) as { data: { format: string; results: Array<{ title: string }> } }
      assert.equal(exaBlocks.data.format, 'exa-mcp')
      assert.equal(exaBlocks.data.results[0]?.title, 'Exa result')

      const exaMarkdown = (await exaSearch.execute({
        query: 'markdown',
      })) as { data: { format: string; results: Array<{ title: string }> } }
      assert.equal(exaMarkdown.data.results[0]?.title, 'Markdown result')

      const exaRaw = (await exaSearch.execute({
        query: 'raw',
      })) as { data: { format: string; content: string; results: unknown[] } }
      assert.equal(exaRaw.data.format, 'mcp-text')
      assert.match(exaRaw.data.content, /without links/)
      assert.equal(exaRaw.data.results.length, 0)

      assert.match(
        String(await exaSearch.execute({ query: 'http-error' })),
        /Exa search failed: HTTP 503/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    if (previousProvider === undefined) delete process.env.WEB_SEARCH_PROVIDER
    else process.env.WEB_SEARCH_PROVIDER = previousProvider
    if (previousUrl === undefined) delete process.env.SEARXNG_URL
    else process.env.SEARXNG_URL = previousUrl
  }

  console.log('ok shell, task, LSP, and WebSearch deterministic paths')
} finally {
  if (webServer?.listening) {
    await new Promise<void>(resolve => webServer!.close(() => resolve()))
  }
  await rm(root, { recursive: true, force: true })
}
