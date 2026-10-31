import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import { resolvePath } from '../utils.js'
import {
  assertAccessibleResolved,
  checkWritePermissionForTool,
  filePathFromInput,
  policyFromContext,
} from '../../utils/permissions/filesystem.js'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { EDIT_FILE_TOOL_NAME } from '../../constants/tool_names.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import {
  getLspManager,
  getLspWorkspaceKey,
} from '../../services/lsp/manager.js'
import { isWorkerExecutionBackend } from '../../execution/worker-execution-backend.js'
import { isWorkerChannelLostError } from '../../execution/worker-channel-error.js'
import {
  activeReadFileState,
  recordWriteInState,
} from '../../utils/read/read-file-state.js'
import type { ReadFileState } from '../../utils/read/types.js'

/** Mode B: model gets `message` ACK; UI gets before/after for the diff view. */
export const EditFileOutputSchema = z.object({
  type: z.literal('update'),
  filePath: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replacements: z.number(),
  message: z.string(),
  beforeContent: z.string(),
  afterContent: z.string(),
})

export type EditFileOutput = z.infer<typeof EditFileOutputSchema>

function ok(data: EditFileOutput): DualChannelToolResult<EditFileOutput> {
  return { data }
}

export const definition: ToolDefinition = {
  name: EDIT_FILE_TOOL_NAME,
  description: 'Make targeted edits by replacing specific text in a file',
  isConcurrencySafe: () => false,
  // Mode B — ACK for model; before/after for UI
  outputSchema: EditFileOutputSchema,
  checkPermissions(input, ctx) {
    return checkWritePermissionForTool(
      ctx.cwd,
      ctx.permissionContext,
      input,
      ['file_path'],
      undefined,
      EDIT_FILE_TOOL_NAME,
    )
  },
  getPath(input) {
    return filePathFromInput(input, ['file_path'])
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as EditFileOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(cwd, context) {
    return tool({
      description:
        'Replace a specific string in an existing file. ' +
        'ALWAYS read the file first so you know the exact text. ' +
        'old_string must match exactly (whitespace matters) and be unique in the file. ' +
        'Include 2-3 lines of surrounding context if needed for uniqueness.',
      inputSchema: z.object({
        file_path: z.string().describe('Path to the file (relative to cwd)'),
        old_string: z
          .string()
          .describe(
            'The exact text to find and replace (must be unique in the file)',
          ),
        new_string: z
          .string()
          .describe('The replacement text (must differ from old_string)'),
        replace_all: z
          .boolean()
          .optional()
          .describe('Replace all occurrences (default: false)'),
      }),
      execute: async ({
        file_path,
        old_string,
        new_string,
        replace_all = false,
      }: {
        file_path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      }) => {
        const execution = context.execution
        // Local Worker: FS path + sandbox (extraWriteRoots for auto-memory).
        // Remote SSH: Worker RPC + assertInWorkspace.
        // Match FileReadTool: gate on environmentId only.
        const useRemoteFs = !!execution && execution.environmentId !== 'local'
        if (useRemoteFs && execution) {
          try {
            const abs = execution.resolve(cwd, file_path)
            execution.assertInWorkspace(cwd, abs, 'write')
            if (!(await execution.exists(abs))) {
              return `Error: file not found: ${file_path}`
            }
            if (await execution.isDirectory(abs)) {
              return `Error: ${file_path} is a directory`
            }
            if (old_string === new_string) {
              return `Error: old_string and new_string are identical`
            }
            if (!old_string) {
              return `Error: old_string cannot be empty — use write_file to create files`
            }
            const content = await execution.readText(abs)
            let search = old_string
            let matchCount = countOccurrences(content, search)
            if (matchCount === 0) {
              const fuzzyResult = fuzzyFind(content, old_string)
              if (!fuzzyResult) {
                return `Error: old_string not found in ${file_path}. Make sure it matches exactly (including whitespace and indentation).`
              }
              search = fuzzyResult
              matchCount = countOccurrences(content, search)
            }
            if (matchCount > 1 && !replace_all) {
              return `Error: found ${matchCount} matches in ${file_path}. Include more context or set replace_all: true.`
            }
            const newContent = replace_all
              ? content.replaceAll(search, new_string)
              : content.replace(search, new_string)
            await execution.writeText(abs, newContent)
            if (isWorkerExecutionBackend(execution)) {
              try {
                const workspaceKey = getLspWorkspaceKey(cwd, context.lspServers)
                clearDeliveredDiagnosticsForFile(workspaceKey, abs)
                await execution.lspChangeFile(abs, newContent)
                await execution.lspSaveFile(abs)
              } catch {
                /* LSP optional */
              }
            }
            const replacements = replace_all ? matchCount : 1
            return ok({
              type: 'update',
              filePath: file_path,
              oldString: old_string,
              newString: new_string,
              replacements,
              beforeContent: content,
              afterContent: newContent,
              message: `Edited ${file_path} (${replacements} replacement${replacements === 1 ? '' : 's'}) [worker:${execution.environmentId}]`,
            })
          } catch (err) {
            if (isWorkerChannelLostError(err)) throw err
            return err instanceof Error ? err.message : String(err)
          }
        }

        const resolved = resolvePath(cwd, file_path)
        if ('error' in resolved) return resolved.error || 'Invalid path'
        const { abs } = resolved

        try {
          assertAccessibleResolved(
            abs,
            policyFromContext(cwd, context.permissionContext),
            'write',
          )
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }

        if (!fs.existsSync(abs)) return `Error: file not found: ${file_path}`
        if (fs.statSync(abs).isDirectory())
          return `Error: ${file_path} is a directory`
        if (old_string === new_string)
          return `Error: old_string and new_string are identical`
        if (!old_string)
          return `Error: old_string cannot be empty — use write_file to create files`

        const content = fs.readFileSync(abs, 'utf-8')

        let search = old_string
        let matchCount = countOccurrences(content, search)

        if (matchCount === 0) {
          const fuzzyResult = fuzzyFind(content, old_string)
          if (!fuzzyResult) {
            return `Error: old_string not found in ${file_path}. Make sure it matches exactly (including whitespace and indentation).`
          }
          search = fuzzyResult
          matchCount = countOccurrences(content, search)
        }

        if (matchCount > 1 && !replace_all) {
          return `Error: found ${matchCount} matches in ${file_path}. Include more context or set replace_all: true.`
        }

        const newContent = replace_all
          ? content.replaceAll(search, new_string)
          : content.replace(search, new_string)

        fs.writeFileSync(abs, newContent, 'utf-8')
        recordWriteInState(
          activeReadFileState(
            context.session?.readFileState as ReadFileState | undefined,
          ),
          abs,
          newContent,
        )

        const manager = getLspManager(cwd, context.lspServers)
        if (manager) {
          const workspaceKey = getLspWorkspaceKey(cwd, context.lspServers)
          clearDeliveredDiagnosticsForFile(workspaceKey, abs)
          console.log(`[lsp:diagnostics] sync edit start file=${file_path}`)
          void (async () => {
            try {
              await manager.changeFile(abs, newContent)
              await manager.saveFile(abs)
              const server = manager.getServerForFile(abs)
              console.log(
                `[lsp:diagnostics] sync edit done file=${file_path} server=${server?.name ?? 'none'} state=${server?.state ?? 'none'}`,
              )
            } catch (err) {
              console.warn(
                `[lsp] failed to sync edit for ${abs}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
            }
          })()
        } else {
          console.log(
            `[lsp:diagnostics] sync edit skip file=${file_path} reason=no-lsp-config`,
          )
        }

        const oldLines = content.split('\n').length
        const newLines = newContent.split('\n').length
        const replacements = replace_all ? matchCount : 1
        const lineInfo =
          oldLines !== newLines ? ` (${oldLines} → ${newLines} lines)` : ''

        return ok({
          type: 'update',
          filePath: file_path,
          oldString: old_string,
          newString: new_string,
          replacements,
          beforeContent: content,
          afterContent: newContent,
          message: `Edited ${file_path}: ${replacements} replacement(s)${lineInfo}`,
        })
      },
    })
  },
}

function countOccurrences(text: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

function fuzzyFind(content: string, search: string): string | null {
  const contentLines = content.split('\n')
  const searchLines = search.split('\n')

  if (searchLines[searchLines.length - 1] === '') searchLines.pop()
  if (searchLines.length === 0) return null

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }
    if (matches) {
      return contentLines.slice(i, i + searchLines.length).join('\n')
    }
  }

  return null
}
