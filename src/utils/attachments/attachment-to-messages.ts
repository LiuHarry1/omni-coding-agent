import type { Message, UserContentPart, UserMessage } from '../../core/types.js'
import type { Attachment } from './types.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'
import { getDefaultShellToolName } from '../../core/shell/shell-utils.js'
import { MAX_LINES_TO_READ } from '../../constants/api_limits.js'
import { formatReadOutputAsToolString } from '../read/index.js'
import type { ReadOutput } from '../read/types.js'

function metaUserMessage(content: string | UserContentPart[]): UserMessage {
  return { role: 'user', content, isMeta: true }
}

/** Model-facing abs path: forward slashes so git-bash `cp` can copy the string as-is. */
export function toModelFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function createToolUseMessage(
  toolName: string,
  input: Record<string, string | number>,
): UserMessage {
  return metaUserMessage(
    `Called the ${toolName} tool with the following input: ${JSON.stringify(input)}`,
  )
}

export function syntheticReadCallMessage(filePath: string): UserMessage {
  return createToolUseMessage(FILE_READ_TOOL_NAME, {
    file_path: toModelFilePath(filePath),
  })
}

function createToolResultTextMessage(
  toolName: string,
  resultText: string,
): UserMessage {
  return metaUserMessage(
    `Result of calling the ${toolName} tool:\n${resultText}`,
  )
}

function createToolResultImageMessage(
  toolName: string,
  output: Extract<ReadOutput, { type: 'image' }>,
): UserMessage {
  const parts: UserContentPart[] = [
    {
      type: 'text',
      text: `Result of calling the ${toolName} tool: [Image ${output.file.filePath}]`,
    },
    {
      type: 'image',
      image: Buffer.from(output.file.base64, 'base64'),
      mediaType: output.file.mediaType,
    },
  ]
  return metaUserMessage(parts)
}

function fileAttachmentToMessages(attachment: {
  filename: string
  displayPath: string
  content: ReadOutput
  truncated?: boolean
  note?: string
}): Message[] {
  const msgs: Message[] = [syntheticReadCallMessage(attachment.filename)]

  if (attachment.content.type === 'image') {
    msgs.push(
      createToolResultImageMessage(FILE_READ_TOOL_NAME, attachment.content),
    )
  } else {
    msgs.push(
      createToolResultTextMessage(
        FILE_READ_TOOL_NAME,
        formatReadOutputAsToolString(attachment.content),
      ),
    )
  }

  if (attachment.truncated) {
    msgs.push(
      metaUserMessage(
        `Note: The file ${attachment.displayPath} was too large and has been truncated to the first ${MAX_LINES_TO_READ} lines. Don't tell the user about this truncation. Use ${FILE_READ_TOOL_NAME} to read more of the file if you need.`,
      ),
    )
  }

  if (attachment.note) msgs.push(metaUserMessage(attachment.note))

  return msgs
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function attachmentToMessages(attachment: Attachment): Message[] {
  switch (attachment.type) {
    case 'directory': {
      const shellToolName = getDefaultShellToolName()
      return [
        createToolUseMessage(shellToolName, {
          command: `ls ${JSON.stringify(attachment.path)}`,
          description: `Lists files in ${attachment.displayPath}`,
        }),
        createToolResultTextMessage(shellToolName, attachment.content),
      ]
    }

    case 'file':
    case 'already_read_file':
      return fileAttachmentToMessages(attachment)

    case 'uploaded_binary':
      return [
        metaUserMessage(
          `The user attached ${attachment.displayPath} (${attachment.mediaType}, ${formatFileSize(attachment.fileSize)}). ` +
            `Its contents cannot be shown inline. The file is saved at ${toModelFilePath(attachment.filename)} — ` +
            `copy or process that on-disk path (do not rebuild it from the original filename). ` +
            `Use ${getDefaultShellToolName()} to inspect or convert it (for example a Python one-liner with python-docx, openpyxl, or python-pptx) ` +
            `before answering questions about it.`,
        ),
      ]

    case 'pdf_reference':
      return [
        metaUserMessage(
          `PDF file: ${attachment.displayPath} (${attachment.pageCount} pages, ${formatFileSize(attachment.fileSize)}). ` +
            `On disk: ${toModelFilePath(attachment.filename)}. ` +
            `This PDF is too large to read all at once. You MUST use the ${FILE_READ_TOOL_NAME} tool with ` +
            `file_path ${JSON.stringify(toModelFilePath(attachment.filename))} and the pages parameter ` +
            `to read specific page ranges (e.g., pages: "1-5"). Do NOT call ${FILE_READ_TOOL_NAME} without the pages parameter ` +
            `or it will fail. Start by reading the first few pages to understand the structure, then read more as needed. ` +
            `Maximum 20 pages per request.`,
        ),
      ]
    case 'plan_mode':
    case 'plan_mode_reentry':
    case 'plan_mode_exit':
    case 'diagnostics':
    case 'skill_listing':
    case 'invoked_skills':
    case 'agent_listing_delta':
    case 'agent_mention':
    case 'task_notification':
    case 'relevant_memories':
    case 'conditional_rules':
      // Handled in messages.normalizeAttachmentForAPI (system-reminder path).
      return []
    default: {
      const _exhaustive: never = attachment
      return _exhaustive
    }
  }
}
