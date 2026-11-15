/**
 * Each mode refuses the calls it does not allow, on a tool list that stays
 * the same in every mode.
 */
import '../tools.js'
import {
  modeDenial,
  withModeGate,
} from '../utils/permissions/mode-restrictions.js'
import { isToolReadOnly } from '../core/tool-definition.js'
import { defaultRegistry } from '../core/tool-registry.js'
import type { ExternalMode } from '../utils/permissions/permission-mode.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const isReadOnly = (name: string) => isToolReadOnly(defaultRegistry.get(name))
const allows = (mode: ExternalMode, name: string) =>
  modeDenial(mode, name, isReadOnly) === undefined

for (const name of [
  WRITE_FILE_TOOL_NAME,
  BASH_TOOL_NAME,
  'mcp__docs__search',
]) {
  assert(!allows('ask', name), `ask refuses ${name}`)
}
for (const name of [
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
]) {
  assert(allows('ask', name), `ask allows ${name}`)
}

assert(allows('agent', WRITE_FILE_TOOL_NAME), 'agent allows Write')
assert(allows('agent', ENTER_PLAN_MODE_TOOL_NAME), 'agent allows EnterPlanMode')
assert(!allows('agent', EXIT_PLAN_MODE_TOOL_NAME), 'agent refuses ExitPlanMode')

assert(
  allows('plan', EDIT_FILE_TOOL_NAME),
  'plan allows Edit for the plan file',
)
assert(allows('plan', EXIT_PLAN_MODE_TOOL_NAME), 'plan allows ExitPlanMode')
assert(!allows('plan', BASH_TOOL_NAME), 'plan refuses Bash')
assert(!allows('plan', ENTER_PLAN_MODE_TOOL_NAME), 'plan refuses EnterPlanMode')

let mode: ExternalMode = 'agent'
let reachedInnerGate = 0
const gate = withModeGate(
  () => {
    reachedInnerGate++
    return { behavior: 'allow' }
  },
  () => mode,
  isReadOnly,
)
assert(
  (await gate(BASH_TOOL_NAME, {})).behavior === 'allow',
  'agent mode passes Bash to the permission check',
)
mode = 'plan'
const refused = await gate(BASH_TOOL_NAME, {})
assert(refused.behavior === 'deny', 'the gate reads the mode at call time')
assert(
  reachedInnerGate === 1,
  'a refused call never reaches the permission check',
)

console.log('mode restriction tests OK')
