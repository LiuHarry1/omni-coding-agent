/**
 * Canonical tool names. Import from here everywhere.
 */

export const BASH_TOOL_NAME = 'Bash'
export const POWERSHELL_TOOL_NAME = 'PowerShell'
export const FILE_READ_TOOL_NAME = 'Read'
export const WRITE_FILE_TOOL_NAME = 'Write'
export const EDIT_FILE_TOOL_NAME = 'Edit'
export const LIST_DIR_TOOL_NAME = 'list_dir'
export const TODO_WRITE_TOOL_NAME = 'TodoWrite'
export const WEB_SEARCH_TOOL_NAME = 'WebSearch'
export const WEB_FETCH_TOOL_NAME = 'WebFetch'
export const GLOB_TOOL_NAME = 'Glob'
export const GREP_TOOL_NAME = 'Grep'
export const LSP_TOOL_NAME = 'LSP'
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'
export const SKILL_TOOL_NAME = 'Skill'
export const AGENT_TOOL_NAME = 'Agent'
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage'
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const TASK_OUTPUT_TOOL_NAME = 'TaskOutput'
export const TASK_STOP_TOOL_NAME = 'TaskStop'
export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_LIST_TOOL_NAME = 'CronList'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'

export const CRON_TOOL_NAMES: readonly string[] = [
  CRON_CREATE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
]

export const BROWSER_NAVIGATE_TOOL_NAME = 'browser_navigate'
export const BROWSER_SNAPSHOT_TOOL_NAME = 'browser_snapshot'
export const BROWSER_GET_TEXT_TOOL_NAME = 'browser_get_text'
export const BROWSER_CLICK_TOOL_NAME = 'browser_click'
export const BROWSER_MOUSE_CLICK_XY_TOOL_NAME = 'browser_mouse_click_xy'
export const BROWSER_TYPE_TOOL_NAME = 'browser_type'
export const BROWSER_FILL_FORM_TOOL_NAME = 'browser_fill_form'
export const BROWSER_SELECT_OPTION_TOOL_NAME = 'browser_select_option'
export const BROWSER_FILE_UPLOAD_TOOL_NAME = 'browser_file_upload'
export const BROWSER_HANDLE_DIALOG_TOOL_NAME = 'browser_handle_dialog'
export const BROWSER_PRESS_KEY_TOOL_NAME = 'browser_press_key'
export const BROWSER_WAIT_FOR_TOOL_NAME = 'browser_wait_for'
export const BROWSER_HOVER_TOOL_NAME = 'browser_hover'
export const BROWSER_SCROLL_TOOL_NAME = 'browser_scroll'
export const BROWSER_SCREENSHOT_TOOL_NAME = 'browser_screenshot'
export const BROWSER_CONSOLE_TOOL_NAME = 'browser_console'
export const BROWSER_NETWORK_TOOL_NAME = 'browser_network'
export const BROWSER_TABS_TOOL_NAME = 'browser_tabs'
export const BROWSER_LOCK_TOOL_NAME = 'browser_lock'
export const BROWSER_DRAG_TOOL_NAME = 'browser_drag'
export const BROWSER_RESIZE_TOOL_NAME = 'browser_resize'
export const BROWSER_WAIT_FOR_DOWNLOAD_TOOL_NAME = 'browser_wait_for_download'
export const BROWSER_HIGHLIGHT_TOOL_NAME = 'browser_highlight'
export const BROWSER_GET_BOUNDING_BOX_TOOL_NAME = 'browser_get_bounding_box'
export const BROWSER_CDP_TOOL_NAME = 'browser_cdp'

export const BROWSER_TOOL_NAMES: readonly string[] = [
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_GET_TEXT_TOOL_NAME,
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_MOUSE_CLICK_XY_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_FILL_FORM_TOOL_NAME,
  BROWSER_SELECT_OPTION_TOOL_NAME,
  BROWSER_FILE_UPLOAD_TOOL_NAME,
  BROWSER_HANDLE_DIALOG_TOOL_NAME,
  BROWSER_PRESS_KEY_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
  BROWSER_HOVER_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_LOCK_TOOL_NAME,
  BROWSER_DRAG_TOOL_NAME,
  BROWSER_RESIZE_TOOL_NAME,
  BROWSER_WAIT_FOR_DOWNLOAD_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  BROWSER_CDP_TOOL_NAME,
]

/** Browser tools that only observe; these declare themselves read-only. */
export const BROWSER_READ_ONLY_TOOL_NAMES: readonly string[] = [
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_GET_TEXT_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_CONSOLE_TOOL_NAME,
  BROWSER_NETWORK_TOOL_NAME,
  BROWSER_TABS_TOOL_NAME,
  BROWSER_WAIT_FOR_TOOL_NAME,
  BROWSER_LOCK_TOOL_NAME,
]

export const MUTATING_TOOLS: readonly string[] = [
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
]

export const INTERACTIVE_TOOLS: readonly string[] = [
  ASK_USER_QUESTION_TOOL_NAME,
]

/** Tools denied in Plan mode (plan file writes allowed via guard). */
export const PLAN_MODE_DENIED_TOOLS: readonly string[] = [
  ...MUTATING_TOOLS.filter(
    t => t !== WRITE_FILE_TOOL_NAME && t !== EDIT_FILE_TOOL_NAME,
  ),
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  // Looking at a page is research; clicking through it changes state on
  // whatever the page talks to, which is exactly what plan mode withholds.
  ...BROWSER_TOOL_NAMES.filter(
    name => !BROWSER_READ_ONLY_TOOL_NAMES.includes(name),
  ),
]
