import { defaultRegistry } from './core/tool-registry.js'
import {
  isBashToolEnabled,
  isPowerShellToolEnabled,
} from './core/shell/shell-utils.js'
import { definition as bash } from './tools/BashTool/BashTool.js'
import { definition as powershell } from './tools/PowerShellTool/PowerShellTool.js'
import { definition as readFile } from './tools/FileReadTool/FileReadTool.js'
import { definition as writeFile } from './tools/FileWriteTool/FileWriteTool.js'
import { definition as editFile } from './tools/FileEditTool/FileEditTool.js'
import { definition as todoWrite } from './tools/TodoWriteTool/TodoWriteTool.js'
import { definition as webSearch } from './tools/WebSearchTool/WebSearchTool.js'
import { definition as webFetch } from './tools/WebFetchTool/WebFetchTool.js'
import { definition as globTool } from './tools/GlobTool/GlobTool.js'
import { definition as grepTool } from './tools/GrepTool/GrepTool.js'
import { definition as lspTool } from './tools/LSPTool/LSPTool.js'
import { definition as askUserQuestion } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { definition as taskOutput } from './tools/TaskOutputTool/TaskOutputTool.js'
import { definition as taskStop } from './tools/TaskStopTool/TaskStopTool.js'
import { definition as cronCreate } from './tools/ScheduleCronTool/CronCreateTool.js'
import { definition as cronList } from './tools/ScheduleCronTool/CronListTool.js'
import { definition as cronDelete } from './tools/ScheduleCronTool/CronDeleteTool.js'
import { browserToolDefinitions } from './tools/BrowserTool/BrowserTool.js'

const shellTools = [
  ...(isBashToolEnabled() ? [bash] : []),
  ...(isPowerShellToolEnabled() ? [powershell] : []),
]

;[
  ...shellTools,
  taskOutput,
  taskStop,
  cronCreate,
  cronList,
  cronDelete,
  readFile,
  writeFile,
  editFile,
  globTool,
  grepTool,
  lspTool,
  todoWrite,
  webSearch,
  webFetch,
  askUserQuestion,
  ...browserToolDefinitions,
].forEach(def => defaultRegistry.register(def))

export { defaultRegistry }
export { assembleToolPool } from './tools/assembleToolPool.js'
