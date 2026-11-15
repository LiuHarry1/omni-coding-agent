import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../core/types.js'
import { isToolReadOnly } from '../../core/tool-definition.js'
import { isDeferredTool } from '../../core/tool-enablement.js'
import {
  createMcpResourceToolDefinitions,
  type McpResourceSource,
} from './McpResourceTools.js'

let scratch: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-resources-'))
  // Without a session the file goes under the user's app directory.
  vi.stubEnv('HOME', scratch)
  vi.stubEnv('USERPROFILE', scratch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(scratch, { recursive: true, force: true })
})

function tools(source: Partial<McpResourceSource>) {
  const [list, read] = createMcpResourceToolDefinitions(
    source as McpResourceSource,
  )
  const run = async (def: typeof list, args: object) => {
    const instance = def!.create(scratch, {} as ToolContext) as unknown as {
      execute: (args: object, options: object) => Promise<unknown>
    }
    const output = await instance.execute(args, {
      toolCallId: 't1',
      messages: [],
    })
    if (typeof output === 'string') return output
    return def!.mapToolResultToToolResultBlockParam!(
      (output as { data: unknown }).data,
      't1',
    ).content as string
  }
  return {
    list: list!,
    read: read!,
    runList: (args: object = {}) => run(list, args),
    runRead: (args: object) => run(read, args),
  }
}

describe('MCP resource tools', () => {
  it('are read-only and found through tool search', () => {
    const { list, read } = tools({})
    expect([list.name, read.name]).toEqual([
      'ListMcpResources',
      'ReadMcpResource',
    ])
    for (const def of [list, read]) {
      expect(isToolReadOnly(def)).toBe(true)
      expect(isDeferredTool(def)).toBe(true)
      expect(def.isConcurrencySafe?.({})).toBe(true)
    }
  })

  it('lists resources, optionally for one server', async () => {
    const listResources = vi.fn(async () => [
      { server: 'docs', uri: 'memo://note', name: 'note' },
    ])
    const { runList } = tools({ listResources })

    expect(JSON.parse(await runList())).toEqual([
      { server: 'docs', uri: 'memo://note', name: 'note' },
    ])
    expect(listResources).toHaveBeenLastCalledWith(undefined)

    await runList({ server: 'docs' })
    expect(listResources).toHaveBeenLastCalledWith('docs')
  })

  it('says so when there are no resources', async () => {
    const { runList } = tools({ listResources: async () => [] })
    expect(await runList()).toMatch(/^No resources found/)
  })

  it('returns the reason a call failed', async () => {
    const failing = async () => {
      throw new Error('Server "nope" not found. Available servers: docs')
    }
    const { runList, runRead } = tools({
      listResources: failing,
      readResource: failing,
    })
    expect(await runList({ server: 'nope' })).toBe(
      'Error: Server "nope" not found. Available servers: docs',
    )
    expect(await runRead({ server: 'nope', uri: 'memo://note' })).toBe(
      'Error: Server "nope" not found. Available servers: docs',
    )
  })

  it('returns text as it is', async () => {
    const { runRead } = tools({
      readResource: async () => [
        { uri: 'memo://note', mimeType: 'text/plain', text: 'remember' },
      ],
    })
    expect(
      JSON.parse(await runRead({ server: 'docs', uri: 'memo://note' })),
    ).toEqual({
      contents: [
        { uri: 'memo://note', mimeType: 'text/plain', text: 'remember' },
      ],
    })
  })

  it('saves binary content to a file instead of returning it', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
    const { runRead } = tools({
      readResource: async () => [
        {
          uri: 'memo://pixel',
          mimeType: 'image/png',
          blob: bytes.toString('base64'),
        },
      ],
    })

    const text = await runRead({ server: 'docs', uri: 'memo://pixel' })
    expect(text).not.toContain(bytes.toString('base64'))
    const [content] = JSON.parse(text).contents
    expect(content.blobSavedTo).toMatch(/mcp-resource-[\w-]+\.png$/)
    expect(content.text).toContain('[Resource from docs at memo://pixel]')
    expect(
      fs.realpathSync(content.blobSavedTo).startsWith(fs.realpathSync(scratch)),
    ).toBe(true)
    expect(fs.readFileSync(content.blobSavedTo)).toEqual(bytes)
  })
})
