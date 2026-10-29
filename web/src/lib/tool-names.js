/**
 * Canonical tool names — keep in sync with src/constants/tool_names.ts
 */

export const BASH = 'Bash'
export const POWERSHELL = 'PowerShell'
export const READ = 'Read'
export const WRITE = 'Write'
export const EDIT = 'Edit'
export const LIST_DIR = 'list_dir'
export const TODO_WRITE = 'TodoWrite'
export const WEB_SEARCH = 'WebSearch'
export const WEB_FETCH = 'WebFetch'
export const GLOB = 'Glob'
export const GREP = 'Grep'
export const LSP = 'LSP'
export const ASK_USER_QUESTION = 'AskUserQuestion'
export const TOOL_SEARCH = 'ToolSearch'
export const SKILL = 'Skill'
export const AGENT = 'Agent'
export const ENTER_PLAN_MODE = 'EnterPlanMode'
export const EXIT_PLAN_MODE = 'ExitPlanMode'
export const TASK_OUTPUT = 'TaskOutput'
export const TASK_STOP = 'TaskStop'
export const CRON_CREATE = 'CronCreate'
export const CRON_LIST = 'CronList'
export const CRON_DELETE = 'CronDelete'

export const BROWSER_NAVIGATE = 'browser_navigate'
export const BROWSER_SNAPSHOT = 'browser_snapshot'
export const BROWSER_GET_TEXT = 'browser_get_text'
export const BROWSER_CLICK = 'browser_click'
export const BROWSER_TYPE = 'browser_type'
export const BROWSER_FILL_FORM = 'browser_fill_form'
export const BROWSER_SELECT_OPTION = 'browser_select_option'
export const BROWSER_FILE_UPLOAD = 'browser_file_upload'
export const BROWSER_HANDLE_DIALOG = 'browser_handle_dialog'
export const BROWSER_PRESS_KEY = 'browser_press_key'
export const BROWSER_WAIT_FOR = 'browser_wait_for'
export const BROWSER_HOVER = 'browser_hover'
export const BROWSER_SCROLL = 'browser_scroll'
export const BROWSER_SCREENSHOT = 'browser_screenshot'
export const BROWSER_CONSOLE = 'browser_console'
export const BROWSER_NETWORK = 'browser_network'
export const BROWSER_TABS = 'browser_tabs'
export const BROWSER_LOCK = 'browser_lock'
export const BROWSER_DRAG = 'browser_drag'
export const BROWSER_RESIZE = 'browser_resize'
export const BROWSER_WAIT_FOR_DOWNLOAD = 'browser_wait_for_download'
export const BROWSER_HIGHLIGHT = 'browser_highlight'
export const BROWSER_GET_BOUNDING_BOX = 'browser_get_bounding_box'
export const BROWSER_CDP = 'browser_cdp'

export const BROWSER_TOOLS = [
  BROWSER_NAVIGATE,
  BROWSER_SNAPSHOT,
  BROWSER_GET_TEXT,
  BROWSER_CLICK,
  BROWSER_TYPE,
  BROWSER_FILL_FORM,
  BROWSER_SELECT_OPTION,
  BROWSER_FILE_UPLOAD,
  BROWSER_HANDLE_DIALOG,
  BROWSER_PRESS_KEY,
  BROWSER_WAIT_FOR,
  BROWSER_HOVER,
  BROWSER_SCROLL,
  BROWSER_SCREENSHOT,
  BROWSER_CONSOLE,
  BROWSER_NETWORK,
  BROWSER_TABS,
  BROWSER_LOCK,
  BROWSER_DRAG,
  BROWSER_RESIZE,
  BROWSER_WAIT_FOR_DOWNLOAD,
  BROWSER_HIGHLIGHT,
  BROWSER_GET_BOUNDING_BOX,
  BROWSER_CDP,
]

/** Shown elsewhere / plumbing — keep in sync with TOOL_META.suppress* flags. */
export const SUPPRESSED_TOOL_CARDS = new Set([
  TODO_WRITE,
  ASK_USER_QUESTION,
  ENTER_PLAN_MODE,
  EXIT_PLAN_MODE,
  TOOL_SEARCH,
])

/** Meta tools hidden inside subagent step lists. */
export const SUBAGENT_SUPPRESSED = new Set([TODO_WRITE, TOOL_SEARCH])

/** Tools that create or modify workspace files. */
export const FILE_MUTATING_TOOLS = new Set([
  WRITE,
  EDIT,
  'write_file',
  'edit_file',
])

/** Shell tools that may indirectly change the workspace tree. */
export const SHELL_TOOLS = new Set([BASH, POWERSHELL, 'bash', 'powershell'])
