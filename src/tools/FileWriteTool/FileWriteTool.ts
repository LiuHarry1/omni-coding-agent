import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { resolvePath } from '../utils.js'
import {
  assertAccessibleResolved,
  checkWritePermissionForTool,
  filePathFromInput,
  policyFromContext,
} from '../../utils/permissions/filesystem.js'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { WRITE_FILE_TOOL_NAME } from '../../constants/tool_names.js'
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

/** Mode B: model gets `message` ACK; UI gets content (+ beforeContent on update). */
export const WriteFileOutputSchema = z.object({
  type: z.enum(['create', 'update']),
  filePath: z.string(),
  content: z.string(),
  numLines: z.number(),
  numChars: z.number(),
  message: z.string(),
  beforeContent: z.string().optional(),
})

export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>

export const definition: ToolDefinition = {
  name: WRITE_FILE_TOOL_NAME,
  description: 'Create or overwrite a file',
  isConcurrencySafe: () => false,
  // Mode B — ACK for model; content/before for UI
  outputSchema: WriteFileOutputSchema,
  checkPermissions(input, ctx) {
    return checkWritePermissionForTool(
      ctx.cwd,
      ctx.permissionContext,
      input,
      ['file_path'],
      undefined,
      WRITE_FILE_TOOL_NAME,
    )
  },
  getPath(input) {
    return filePathFromInput(input, ['file_path'])
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as WriteFileOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(cwd, context) {
    return tool({
      description:
        'Create a new file or fully overwrite an existing one. ' +
        'Creates parent directories automatically. ' +
        'Use for NEW files only. For modifying existing files, use edit_file instead.',
      inputSchema: z.object({
        file_path: z
          .string()
          .describe(
            'Path to write. Absolute paths are used as-is; relative paths resolve against cwd. For auto-memory, pass the absolute memory directory path from the system prompt.',
          ),
        content: z.string().describe('Full file content'),
      }),
      execute: async ({
        file_path,
        content,
      }: {
        file_path: string
        content: string
      }): Promise<DualChannelToolResult<WriteFileOutput> | string> => {
        const lines = content.split('\n').length
        const makeData = (
          message: string,
          type: 'create' | 'update',
          beforeContent?: string,
        ): WriteFileOutput => ({
          type,
          filePath: file_path,
          content,
          numLines: lines,
          numChars: content.length,
          message,
          ...(beforeContent !== undefined ? { beforeContent } : {}),
        })

        const execution = context.execution
        // Local Worker has real disk — use FS path below so extraWriteRoots
        // (auto-memory under ~/.ai-agent) apply. Remote SSH still goes
        // through Worker RPC + assertInWorkspace.
        // Match FileReadTool: gate on environmentId, not isWorkerExecutionBackend
        // (that helper also requires configureLsp).
        const useRemoteFs = !!execution && execution.environmentId !== 'local'
        if (useRemoteFs && execution) {
          try {
            const abs = execution.resolve(cwd, file_path)
            execution.assertInWorkspace(cwd, abs, 'write')
            const existed = await execution.exists(abs)
            let beforeContent: string | undefined
            if (existed && !(await execution.isDirectory(abs))) {
              try {
                beforeContent = await execution.readText(abs)
              } catch {
                beforeContent = undefined
              }
            }
            await execution.writeText(abs, content)
            if (isWorkerExecutionBackend(execution)) {
              try {
                const workspaceKey = getLspWorkspaceKey(cwd, context.lspServers)
                clearDeliveredDiagnosticsForFile(workspaceKey, abs)
                await execution.lspChangeFile(abs, content)
                await execution.lspSaveFile(abs)
              } catch {
                /* LSP optional */
              }
            }
            const kind = existed ? 'update' : 'create'
            return {
              data: makeData(
                `Wrote ${file_path} (${lines} lines, ${content.length} chars) [worker:${execution.environmentId}]`,
                kind,
                beforeContent,
              ),
            }
          } catch (err) {
            if (isWorkerChannelLostError(err)) throw err
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        const resolved = resolvePath(cwd, file_path)
        if ('error' in resolved) {
          return `Error: ${resolved.error || 'Invalid path'}`
        }
        const { abs } = resolved

        try {
          assertAccessibleResolved(
            abs,
            policyFromContext(cwd, context.permissionContext),
            'write',
          )
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }

        const existed = fs.existsSync(abs)
        let beforeContent: string | undefined
        if (existed && !fs.statSync(abs).isDirectory()) {
          try {
            beforeContent = fs.readFileSync(abs, 'utf-8')
          } catch {
            beforeContent = undefined
          }
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf-8')
        recordWriteInState(
          activeReadFileState(
            context.session?.readFileState as ReadFileState | undefined,
          ),
          abs,
          content,
        )

        const manager = getLspManager(cwd, context.lspServers)
        if (manager) {
          const workspaceKey = getLspWorkspaceKey(cwd, context.lspServers)
          clearDeliveredDiagnosticsForFile(workspaceKey, abs)
          console.log(`[lsp:diagnostics] sync write start file=${file_path}`)
          void (async () => {
            try {
              await manager.changeFile(abs, content)
              await manager.saveFile(abs)
              const server = manager.getServerForFile(abs)
              console.log(
                `[lsp:diagnostics] sync write done file=${file_path} server=${server?.name ?? 'none'} state=${server?.state ?? 'none'}`,
              )
            } catch (err) {
              console.warn(
                `[lsp] failed to sync write for ${abs}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
            }
          })()
        } else {
          console.log(
            `[lsp:diagnostics] sync write skip file=${file_path} reason=no-lsp-config`,
          )
        }

        return {
          data: makeData(
            `Wrote ${file_path} (${lines} lines, ${content.length} chars)`,
            existed ? 'update' : 'create',
            beforeContent,
          ),
        }
      },
    })
  },
}
