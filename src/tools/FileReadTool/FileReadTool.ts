import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  buildReadToolDescription,
} from './prompt.js'
import { PDF_MAX_PAGES_PER_READ } from './limits.js'
import {
  readFileCore,
  formatReadOutputAsToolString,
  resolveFileInCwd,
  ReadOutputSchema,
  type ReadOutput,
  activeReadFileState,
  recordReadInState,
  shouldDedupRead,
  formatFileNotFoundMessage,
  readTextFromString,
} from '../../utils/read/index.js'
import type { ReadFileState } from '../../utils/read/types.js'
import {
  isBinaryText,
  needsRemoteBytes,
  readRemoteFileViaHost,
} from '../../utils/read/read-remote.js'
import { readsFromAgentHost } from '../../execution/fs-route.js'
import {
  assertAccessibleResolved,
  checkReadPermissionForTool,
  filePathFromInput,
  policyFromContext,
} from '../../utils/permissions/filesystem.js'

function sessionReadFileState(context: {
  session?: { readFileState?: ReadFileState }
}): ReadFileState | undefined {
  return activeReadFileState(context.session?.readFileState)
}

function unchanged(file_path: string): DualChannelToolResult<ReadOutput> {
  return {
    data: { type: 'file_unchanged', file: { filePath: file_path } },
  }
}

/** FileReadTool — dual-channel: `{ data: ReadOutput }` + mapper. */
export const definition: ToolDefinition = {
  name: FILE_READ_TOOL_NAME,
  description: DESCRIPTION,
  isConcurrencySafe: () => true,
  outputSchema: ReadOutputSchema,
  checkPermissions(input, ctx) {
    return checkReadPermissionForTool(
      ctx.cwd,
      ctx.permissionContext,
      input,
      ['file_path'],
      undefined,
      FILE_READ_TOOL_NAME,
    )
  },
  getPath(input) {
    return filePathFromInput(input, ['file_path'])
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatReadOutputAsToolString(output as ReadOutput),
    }
  },
  create(cwd, context) {
    return tool({
      description: buildReadToolDescription(),
      inputSchema: z.object({
        file_path: z
          .string()
          .describe(
            'The path to the file to read (absolute, or relative to the workspace cwd)',
          ),
        offset: z
          .number()
          .optional()
          .describe(
            'The line number to start reading from. Only provide if the file is too large to read at once. Negative counts from the end of the file.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            'The number of lines to read. Only provide if the file is too large to read at once.',
          ),
        pages: z
          .string()
          .optional()
          .describe(
            `Page range for PDF files (e.g. "1-5", "3"). Max ${PDF_MAX_PAGES_PER_READ} pages per request.`,
          ),
      }),
      execute: async ({
        file_path,
        offset,
        limit,
        pages,
      }: {
        file_path: string
        offset?: number
        limit?: number
        pages?: string
      }): Promise<DualChannelToolResult<ReadOutput> | string> => {
        const state = sessionReadFileState(context)
        const execution = context.execution
        // Local worker still has real disk mtime — use the FS path below for
        // dedup + images/PDF. Only remote environments use Worker RPC.
        // Agent-host harness files (tool-results, uploads, …) are not in the
        // workspace; `readsFromAgentHost` sends them to the FS path below.
        if (execution && execution.environmentId !== 'local') {
          if (!readsFromAgentHost(file_path)) {
            try {
              const abs = execution.resolve(cwd, file_path)
              execution.assertInWorkspace(cwd, abs, 'read')
              if (needsRemoteBytes(abs)) {
                const { output, followUpMessages } =
                  await readRemoteFileViaHost(execution, abs, file_path, {
                    offset,
                    limit,
                    pages,
                    sessionId: context.sessionId,
                    supportsNativePdf:
                      context.provider?.supportsNativePdf?.() === true,
                  })
                return { data: output, newMessages: followUpMessages }
              }
              // Remote FS: no reliable local mtime — skip dedup; share slice/gates.
              const text = await execution.readText(abs)
              if (isBinaryText(text)) {
                return `Error: binary file detected — cannot display ${file_path}`
              }
              return {
                data: readTextFromString(text, file_path, { offset, limit }),
              }
            } catch (err) {
              return `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          }
        }

        const resolved = resolveFileInCwd(cwd, file_path, {
          allowOutsideWorkspace: true,
        })
        if ('error' in resolved) return `Error: ${resolved.error}`

        try {
          assertAccessibleResolved(
            resolved.abs,
            policyFromContext(cwd, context.permissionContext),
            'read',
          )
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }

        if (!fs.existsSync(resolved.abs)) {
          return `Error: ${formatFileNotFoundMessage(cwd, resolved.abs, resolved.displayPath)}`
        }

        // Text-only dedup (images/PDF/pages always re-fetch).
        if (!pages && shouldDedupRead(state, resolved.abs, offset, limit)) {
          return unchanged(file_path)
        }

        try {
          const { output, followUpMessages } = await readFileCore(
            cwd,
            file_path,
            {
              offset,
              limit,
              pages,
              sessionId: context.sessionId,
              supportsNativePdf:
                context.provider?.supportsNativePdf?.() === true,
              allowOutsideWorkspace: true,
            },
          )
          if (output.type === 'text') {
            recordReadInState(
              state,
              resolved.abs,
              output.file.content,
              offset,
              limit,
            )
          }
          return {
            data: output,
            newMessages: followUpMessages,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Error: ${msg}`
        }
      },
    })
  },
}
