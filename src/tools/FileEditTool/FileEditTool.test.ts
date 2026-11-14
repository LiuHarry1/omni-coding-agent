import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  instantiateTool,
  validateToolCall,
} from '../../core/tool-definition.js'
import type { AnyTool, ToolContext } from '../../core/types.js'
import { createFilesystemPermissionContext } from '../../utils/permissions/filesystem.js'
import { definition } from './FileEditTool.js'

let root: string
let outside: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edit-root-')))
  outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'edit-outside-')),
  )
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function editTool(context: Partial<ToolContext> = {}): AnyTool {
  return instantiateTool(definition, root, context as ToolContext)
}

const validate = (input: Record<string, unknown>, tool = editTool()) =>
  validateToolCall(tool, input)

describe('Edit validateInput', () => {
  it('passes an edit that can be applied', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1\n')

    expect(
      await validate({
        file_path: 'a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      }),
    ).toEqual({ result: true })
  })

  it('rejects identical strings without looking at the file', async () => {
    expect(
      await validate({
        file_path: 'missing.ts',
        old_string: 'x',
        new_string: 'x',
      }),
    ).toEqual({
      result: false,
      message: 'Error: old_string and new_string are identical',
    })
  })

  it('rejects a file that does not exist', async () => {
    expect(
      await validate({
        file_path: 'missing.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ).toEqual({ result: false, message: 'Error: file not found: missing.ts' })
  })

  it('rejects text that is not in the file', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1\n')

    const result = await validate({
      file_path: 'a.ts',
      old_string: 'const b = 1',
      new_string: 'const b = 2',
    })

    expect(result).toMatchObject({
      result: false,
      message: expect.stringContaining('old_string not found in a.ts'),
    })
  })

  it('rejects ambiguous text unless every match is to be replaced', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'x = 1\nx = 1\n')
    const edit = { file_path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }

    expect(await validate(edit)).toMatchObject({
      result: false,
      message: expect.stringContaining('found 2 matches in a.ts'),
    })
    expect(await validate({ ...edit, replace_all: true })).toEqual({
      result: true,
    })
  })

  it('says nothing about a path the policy refuses', async () => {
    const secret = path.join(outside, 'secret.ts')
    fs.writeFileSync(secret, 'token = 1\n')
    const tool = editTool({
      permissionContext: createFilesystemPermissionContext(root, {
        mode: 'dontAsk',
      }),
    })

    // Same answer whether or not the file or the text is there.
    for (const file_path of [secret, path.join(outside, 'absent.ts')]) {
      expect(
        await validate(
          { file_path, old_string: 'not there', new_string: 'x' },
          tool,
        ),
      ).toEqual({ result: true })
    }
  })

  it('checks a file outside the workspace the user can be asked about', async () => {
    const tool = editTool({
      permissionContext: createFilesystemPermissionContext(root, {
        mode: 'default',
      }),
    })

    expect(
      await validate(
        {
          file_path: path.join(outside, 'absent.ts'),
          old_string: 'a',
          new_string: 'b',
        },
        tool,
      ),
    ).toMatchObject({ result: false })
  })
})

describe('Edit execute', () => {
  type Execute = (input: Record<string, unknown>) => Promise<unknown>
  const run = (input: Record<string, unknown>) =>
    (editTool() as unknown as { execute: Execute }).execute(input)

  it('applies the edit', async () => {
    const file = path.join(root, 'a.ts')
    fs.writeFileSync(file, 'const a = 1\n')

    const result = await run({
      file_path: 'a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    })

    expect(fs.readFileSync(file, 'utf-8')).toBe('const a = 2\n')
    expect(result).toMatchObject({ data: { replacements: 1 } })
  })

  it('still refuses when the text went away after validation', async () => {
    const file = path.join(root, 'a.ts')
    fs.writeFileSync(file, 'something else\n')

    const result = await run({
      file_path: 'a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    })

    expect(result).toEqual(expect.stringContaining('old_string not found'))
    expect(fs.readFileSync(file, 'utf-8')).toBe('something else\n')
  })
})
