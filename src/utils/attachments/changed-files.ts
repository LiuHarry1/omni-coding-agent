/**
 * Report files the model has read that were changed on disk by something
 * other than its own Edit/Write (the user, a formatter, a shell command).
 */
import * as fs from 'fs'
import { structuredPatch } from 'diff'
import type { ToolUseContext } from '../../core/types.js'
import type { ReadFileStateEntry } from '../read/types.js'
import { addLineNumbers } from '../read/format-for-model.js'
import { readTextFile } from '../read/read-text.js'
import type { Attachment } from './types.js'

const DIFF_SNIPPET_MAX_BYTES = 8192
const DIFF_TIMEOUT_MS = 5_000

/**
 * The changed regions of `fileBContents` with 8 lines of context, numbered by
 * their position in the new file. Empty when the two are identical.
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
    { context: 8, timeout: DIFF_TIMEOUT_MS },
  )
  if (!patch) return ''

  const full = patch.hunks
    .map(hunk =>
      addLineNumbers(
        hunk.lines
          // Drop deleted lines and "\ No newline at end of file" markers.
          .filter(line => !line.startsWith('-') && !line.startsWith('\\'))
          .map(line => line.slice(1)),
        hunk.newStart,
      ),
    )
    .join('\n...\n')

  if (full.length <= DIFF_SNIPPET_MAX_BYTES) return full

  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = full.slice(kept.length).split('\n').length
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}

/** Whether `content` is the whole text of the file as it was on disk. */
function holdsWholeFile(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false
  // Edit/Write leave offset unset; a Read of the whole file records offset 1.
  if (entry.offset === undefined) return true
  return entry.offset === 1 && entry.limit === undefined
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export async function getChangedFiles(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const { readFileState } = toolUseContext
  if (readFileState.size === 0) return []

  const results = await Promise.all(
    [...readFileState.keys()].map(
      async (filePath): Promise<Attachment | null> => {
        const fileState = readFileState.get(filePath)
        if (!fileState || !holdsWholeFile(fileState)) return null

        try {
          const mtime = Math.floor((await fs.promises.stat(filePath)).mtimeMs)
          if (mtime <= fileState.timestamp) return null

          let content: string
          try {
            content = readTextFile(filePath, filePath).file.content
          } catch {
            // Now binary or too large to read whole: nothing to diff.
            return null
          }

          const snippet = getSnippetForTwoFileDiff(fileState.content, content)
          // The model now knows the new content, so report this change once.
          readFileState.set(filePath, { content, timestamp: mtime })
          // Touched but not modified.
          if (snippet === '') return null

          return { type: 'edited_text_file', filename: filePath, snippet }
        } catch (err) {
          // Evict only when the file is really gone. A transient stat failure
          // (an editor's atomic save, a network filesystem hiccup) must not
          // drop a file the model has just read.
          if (isENOENT(err)) readFileState.delete(filePath)
          return null
        }
      },
    ),
  )

  return results.filter((r): r is Attachment => r !== null)
}
