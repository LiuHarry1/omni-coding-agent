/**
 * ListMcpResources / ReadMcpResource — the resources MCP servers offer next
 * to their tools. Registered per turn, and only when a connected server has
 * resources at all. Deferred behind tool search, like the MCP tools they
 * accompany.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tool } from 'ai'
import { z } from 'zod'
import type {
  DualChannelToolResult,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import {
  LIST_MCP_RESOURCES_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
} from '../../constants/tool_names.js'
import type { MCPManager, MCPResourceInfo } from '../../services/mcp/manager.js'
import { formatFileSize } from '../../services/tool-storage/index.js'
import { getScratchDataDir, getSessionDataDir } from '../../session/paths.js'

/** What the tools need from the MCP manager. */
export type McpResourceSource = Pick<
  MCPManager,
  'listResources' | 'readResource'
>

const LIST_DESCRIPTION = `
Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it's from.

Parameters:
- server (optional): The name of a specific MCP server to get resources from. If not provided, resources from all servers will be returned.
`

const READ_DESCRIPTION = `
Reads a specific resource from an MCP server, identified by server name and resource URI.

Parameters:
- server (required): The name of the MCP server from which to read the resource
- uri (required): The URI of the resource to read

Binary content is saved to a file and its path is returned instead.
`

const NO_RESOURCES =
  'No resources found. MCP servers may still provide tools even if they have no resources.'

export const McpResourceToolResultSchema = z.object({ text: z.string() })
type McpResourceToolResult = z.infer<typeof McpResourceToolResultSchema>

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
}

function errorText(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * Write a binary resource next to the session's other tool results, so the
 * model gets a path it can read instead of base64 in its context.
 */
function saveBlob(
  blob: string,
  mimeType: string | undefined,
  sessionId: string | undefined,
): { file: string; size: number } {
  let dir: string
  try {
    dir = sessionId
      ? path.join(getSessionDataDir(sessionId), 'tool-results')
      : getScratchDataDir('mcp-resources')
  } catch {
    dir = getScratchDataDir('mcp-resources')
  }
  fs.mkdirSync(dir, { recursive: true })
  const type = mimeType?.split(';')[0]?.trim().toLowerCase() ?? ''
  const file = path.join(
    dir,
    `mcp-resource-${randomUUID()}.${EXTENSIONS[type] ?? 'bin'}`,
  )
  const bytes = Buffer.from(blob, 'base64')
  fs.writeFileSync(file, bytes)
  return { file, size: bytes.length }
}

const mapResult: ToolDefinition['mapToolResultToToolResultBlockParam'] = (
  output,
  toolUseID,
) => ({
  tool_use_id: toolUseID,
  type: 'tool_result',
  content: (output as McpResourceToolResult).text,
})

function listDefinition(source: McpResourceSource): ToolDefinition {
  return {
    name: LIST_MCP_RESOURCES_TOOL_NAME,
    description: LIST_DESCRIPTION,
    shouldDefer: true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    outputSchema: McpResourceToolResultSchema,
    mapToolResultToToolResultBlockParam: mapResult,
    create() {
      return tool({
        description: LIST_DESCRIPTION,
        inputSchema: z.object({
          server: z
            .string()
            .optional()
            .describe('Optional server name to filter resources by'),
        }),
        execute: async (args: {
          server?: string
        }): Promise<DualChannelToolResult<McpResourceToolResult> | string> => {
          let resources: MCPResourceInfo[]
          try {
            resources = await source.listResources(args.server || undefined)
          } catch (err) {
            return errorText(err)
          }
          return {
            data: {
              text:
                resources.length > 0
                  ? JSON.stringify(resources, null, 2)
                  : NO_RESOURCES,
            },
          }
        },
      })
    },
  }
}

function readDefinition(source: McpResourceSource): ToolDefinition {
  return {
    name: READ_MCP_RESOURCE_TOOL_NAME,
    description: READ_DESCRIPTION,
    shouldDefer: true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    outputSchema: McpResourceToolResultSchema,
    mapToolResultToToolResultBlockParam: mapResult,
    create(_cwd: string, context: ToolContext) {
      return tool({
        description: READ_DESCRIPTION,
        inputSchema: z.object({
          server: z.string().describe('The MCP server name'),
          uri: z.string().describe('The resource URI to read'),
        }),
        execute: async (args: {
          server: string
          uri: string
        }): Promise<DualChannelToolResult<McpResourceToolResult> | string> => {
          try {
            const contents = await source.readResource(args.server, args.uri)
            const readable = contents.map(content => {
              const { uri, mimeType } = content
              if ('text' in content) {
                return { uri, mimeType, text: content.text }
              }
              if (typeof content.blob !== 'string') return { uri, mimeType }
              try {
                const saved = saveBlob(
                  content.blob,
                  mimeType,
                  context.sessionId,
                )
                return {
                  uri,
                  mimeType,
                  blobSavedTo: saved.file,
                  text: `[Resource from ${args.server} at ${uri}] Binary content (${mimeType ?? 'unknown type'}, ${formatFileSize(saved.size)}) saved to ${saved.file}`,
                }
              } catch (err) {
                return {
                  uri,
                  mimeType,
                  text: `Binary content could not be saved to disk: ${err instanceof Error ? err.message : String(err)}`,
                }
              }
            })
            return {
              data: { text: JSON.stringify({ contents: readable }, null, 2) },
            }
          } catch (err) {
            return errorText(err)
          }
        },
      })
    },
  }
}

export function createMcpResourceToolDefinitions(
  source: McpResourceSource,
): ToolDefinition[] {
  return [listDefinition(source), readDefinition(source)]
}
