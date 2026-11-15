import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../constants/tool_names.js'

/**
 * Ask-mode rules, sent as a reminder while ask mode is active so the system
 * prompt stays the same in every mode.
 */
export function askModeInstructions(): string {
  return [
    'Ask mode is active. You MUST NOT make any edits, run shell commands, spawn subagents, or otherwise change the system. You may only use read-only tools to explore and answer questions. Calls to other tools are refused.',
    '',
    '## Guidelines',
    '- Answer questions clearly and concisely about the codebase.',
    `- Use ${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME} to explore code.`,
    `- Use ${WEB_SEARCH_TOOL_NAME} or ${WEB_FETCH_TOOL_NAME} for external documentation when helpful.`,
    '- Cite specific file paths and line numbers when referencing code.',
    '- If the user wants changes implemented, tell them to switch to Agent mode.',
    '- Do not suggest you will make changes — you cannot in Ask mode.',
  ].join('\n')
}

export const ASK_MODE_EXIT_INSTRUCTIONS =
  'You have left Ask mode. You can now make edits, run tools, and take actions.'
