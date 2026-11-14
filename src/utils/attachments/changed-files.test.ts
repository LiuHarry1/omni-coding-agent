import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session, ToolUseContext } from '../../core/types.js'
import { expandAttachmentMessagesForAPI } from '../messages.js'
import { createAttachmentMessage } from '../attachments.js'
import {
  recordReadInState,
  recordWriteInState,
} from '../read/read-file-state.js'
import type { ReadFileState } from '../read/types.js'
import { getChangedFiles, getSnippetForTwoFileDiff } from './changed-files.js'

let dir: string
let readFileState: ReadFileState
let ctx: ToolUseContext

/** Rewrite a file the way an outside editor would: new content, later mtime. */
function changeOutside(file: string, content: string): void {
  const later = new Date(fs.statSync(file).mtimeMs + 5_000)
  fs.writeFileSync(file, content)
  fs.utimesSync(file, later, later)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-files-'))
  readFileState = new Map()
  ctx = {
    cwd: dir,
    session: { id: 's1', messages: [] } as unknown as Session,
    readFileState,
    options: { tools: {} },
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('getSnippetForTwoFileDiff', () => {
  it('is empty for identical content', () => {
    expect(getSnippetForTwoFileDiff('a\nb\n', 'a\nb\n')).toBe('')
  })

  it('shows the changed region numbered by the new file', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const after = [...before]
    after[19] = 'line 20 changed'

    const snippet = getSnippetForTwoFileDiff(
      before.join('\n'),
      after.join('\n'),
    )
    const lines = snippet.split('\n')

    // 8 lines of context on each side of line 20.
    expect(lines[0]).toBe('  12│line 12')
    expect(lines).toContain('  20│line 20 changed')
    expect(lines.at(-1)).toBe('  28│line 28')
    expect(snippet).not.toContain('│line 20\n')
  })

  it('cuts a very large change at a line boundary', () => {
    const after = Array.from({ length: 2_000 }, (_, i) => `new ${i}`).join('\n')

    const snippet = getSnippetForTwoFileDiff('', after)

    expect(snippet.length).toBeLessThan(8_300)
    expect(snippet).toMatch(/\n\n\.\.\. \[\d+ lines truncated\] \.\.\.$/)
  })
})

describe('getChangedFiles', () => {
  it('reports a file changed outside the agent, once', async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'const a = 1\nconst b = 2\n')
    recordReadInState(
      readFileState,
      file,
      'const a = 1\nconst b = 2\n',
      1,
      undefined,
    )

    changeOutside(file, 'const a = 1\nconst b = 3\n')

    const first = await getChangedFiles(ctx)
    expect(first).toEqual([
      {
        type: 'edited_text_file',
        filename: file,
        snippet: expect.stringContaining('   2│const b = 3'),
      },
    ])
    expect(await getChangedFiles(ctx)).toEqual([])
    expect(readFileState.get(file)?.content).toBe('const a = 1\nconst b = 3\n')
  })

  it('says nothing about a file that has not changed', async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'same\n')
    recordReadInState(readFileState, file, 'same\n', undefined, undefined)

    expect(await getChangedFiles(ctx)).toEqual([])
  })

  it("does not report the agent's own edit", async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'old\n')
    recordReadInState(readFileState, file, 'old\n', 1, undefined)

    fs.writeFileSync(file, 'new\n')
    recordWriteInState(readFileState, file, 'new\n')

    expect(await getChangedFiles(ctx)).toEqual([])
  })

  it('reports an outside change to a file the agent wrote', async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'written\n')
    recordWriteInState(readFileState, file, 'written\n')

    changeOutside(file, 'reformatted\n')

    expect(await getChangedFiles(ctx)).toHaveLength(1)
  })

  it('skips a file touched without a content change', async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'same\n')
    recordReadInState(readFileState, file, 'same\n', 1, undefined)
    const before = readFileState.get(file)!.timestamp

    changeOutside(file, 'same\n')

    expect(await getChangedFiles(ctx)).toEqual([])
    expect(readFileState.get(file)!.timestamp).toBeGreaterThan(before)
  })

  it('skips files the model has only seen part of', async () => {
    const ranged = path.join(dir, 'ranged.ts')
    const partial = path.join(dir, 'partial.ts')
    fs.writeFileSync(ranged, 'l1\nl2\nl3\n')
    fs.writeFileSync(partial, 'l1\nl2\nl3\n')
    recordReadInState(readFileState, ranged, 'l2', 2, 1)
    readFileState.set(partial, {
      content: 'l1',
      timestamp: Math.floor(fs.statSync(partial).mtimeMs),
      isPartialView: true,
    })

    changeOutside(ranged, 'l1\nchanged\nl3\n')
    changeOutside(partial, 'l1\nchanged\nl3\n')

    expect(await getChangedFiles(ctx)).toEqual([])
    expect(readFileState.get(ranged)?.content).toBe('l2')
  })

  it('forgets a file that was deleted', async () => {
    const file = path.join(dir, 'gone.ts')
    fs.writeFileSync(file, 'x\n')
    recordReadInState(readFileState, file, 'x\n', 1, undefined)
    fs.rmSync(file)

    expect(await getChangedFiles(ctx)).toEqual([])
    expect(readFileState.has(file)).toBe(false)
  })

  it('keeps a file that turned binary without reporting it', async () => {
    const file = path.join(dir, 'a.bin')
    fs.writeFileSync(file, 'text\n')
    recordReadInState(readFileState, file, 'text\n', 1, undefined)
    const later = new Date(fs.statSync(file).mtimeMs + 5_000)
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 0, 255, 0, 0, 7]))
    fs.utimesSync(file, later, later)

    expect(await getChangedFiles(ctx)).toEqual([])
    expect(readFileState.has(file)).toBe(true)
  })
})

describe('edited_text_file for the model', () => {
  it('is a system reminder telling the model not to revert the change', () => {
    const [message] = expandAttachmentMessagesForAPI([
      createAttachmentMessage({
        type: 'edited_text_file',
        filename: '/repo/a.ts',
        snippet: '   2│const b = 3',
      }),
    ])

    expect(message).toMatchObject({ role: 'user' })
    const text = JSON.stringify(message)
    expect(text).toContain('<system-reminder>')
    expect(text).toContain(
      'Note: /repo/a.ts was modified, either by the user or by a linter.',
    )
    expect(text).toContain('   2│const b = 3')
  })
})
