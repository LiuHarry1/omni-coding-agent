import {
  MAX_LINES_TO_READ,
  MAX_OUTPUT_SIZE_BYTES,
  PDF_MAX_PAGES_PER_READ,
} from './limits.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'
import { getAvailableShellToolNames } from '../../core/shell/shell-utils.js'

export { FILE_READ_TOOL_NAME }

/** Short registry / search hint. */
export const DESCRIPTION = 'Read a file from the local filesystem.'

const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

const OFFSET_INSTRUCTION =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

function directoryListTool(): string {
  return getAvailableShellToolNames()
    .map(name => `\`${name}\``)
    .join(' or ')
}

/**
 * Model-facing Read prompt.
 *
 * Behavior specific to this runtime:
 * - `file_path` may be absolute or workspace-relative (`resolvePath`).
 * - PDF is always available (native document or page images).
 */
export function buildReadToolDescription(): string {
  const maxKb = Math.round(MAX_OUTPUT_SIZE_BYTES / 1024)
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter may be an absolute path or a path relative to the workspace cwd
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file. Files larger than ${maxKb} KB will return an error; use offset and limit for larger files
${OFFSET_INSTRUCTION}
${LINE_FORMAT_INSTRUCTION}
- This tool can read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually.
- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${directoryListTool()} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`
}
