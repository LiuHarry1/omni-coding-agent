import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { tool } from 'ai'
import { z } from 'zod'
import type { AnyTool } from '../../core/types.js'
import {
  EDIT_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { resolveToolFilePath } from '../../core/forked-agent.js'
import { claimAiAgentPath } from '../../utils/sandbox-owner.js'
import { isAutoMemPath } from './paths.js'

function allowedPath(filePath: string, memoryDir: string): string | undefined {
  const abs = resolveToolFilePath(filePath)
  return isAutoMemPath(abs, memoryDir) ? abs : undefined
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, filePath)
    claimAiAgentPath(filePath)
  } finally {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // Best-effort cleanup after a failed rename/write.
    }
  }
}

/**
 * Auto Memory is a trusted side path and must remain writable even when the
 * selected main-thread profile intentionally omits general Write/Edit tools.
 */
export function createAutoMemoryWriteTools(
  memoryDir: string,
): Record<string, AnyTool> {
  const root = path.resolve(memoryDir)

  const write = tool({
    description: `Create or overwrite a markdown memory file only within ${root}.`,
    inputSchema: z.object({
      file_path: z.string(),
      content: z.string(),
    }),
    execute: async ({
      file_path,
      content,
    }: {
      file_path: string
      content: string
    }) => {
      const abs = allowedPath(file_path, root)
      if (!abs) return `Error: Write is limited to ${root}`
      atomicWrite(abs, content)
      return `Wrote ${abs}`
    },
  }) as AnyTool

  const edit = tool({
    description: `Replace text in an existing markdown memory file only within ${root}.`,
    inputSchema: z.object({
      file_path: z.string(),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
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
      const abs = allowedPath(file_path, root)
      if (!abs) return `Error: Edit is limited to ${root}`
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return `Error: file not found: ${abs}`
      }
      const current = fs.readFileSync(abs, 'utf-8')
      const matches = current.split(old_string).length - 1
      if (matches === 0) return `Error: old_string not found in ${abs}`
      if (matches > 1 && !replace_all) {
        return `Error: found ${matches} matches in ${abs}; add context or set replace_all`
      }
      const next = replace_all
        ? current.replaceAll(old_string, new_string)
        : current.replace(old_string, new_string)
      atomicWrite(abs, next)
      return `Edited ${abs}: ${replace_all ? matches : 1} replacement(s)`
    },
  }) as AnyTool

  return {
    [WRITE_FILE_TOOL_NAME]: write,
    [EDIT_FILE_TOOL_NAME]: edit,
  }
}
