import {
  parseAgentFromMarkdown,
  findPrimaryAgent,
} from '../tools/AgentTool/mergeAgents.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import { browserAgentSessionSection } from '../prompts/browser-agent-session.js'
import { getSystemPromptForAgentProfile } from '../prompts/agent-profile.js'
import { computeSimpleEnvInfo } from '../constants/prompts.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  CDP_DESCRIPTION,
  CDP_SUMMARY,
  CLICK_DESCRIPTION,
  FILE_UPLOAD_DESCRIPTION,
  FILL_FORM_DESCRIPTION,
  LOCK_DESCRIPTION,
  MOUSE_CLICK_XY_DESCRIPTION,
  SNAPSHOT_DESCRIPTION,
  TYPE_DESCRIPTION,
  WAIT_FOR_DESCRIPTION,
} from '../tools/BrowserTool/prompt.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const smart = parseAgentFromMarkdown({
  filePath: 'x/reviewer.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'reviewer',
    label: 'Code Reviewer',
    description: 'Review code before merge',
    mode: 'primary',
    disallowedTools: 'search-memory_*',
  },
  body: 'You are the code reviewer.',
})
assert(!!smart.agent, smart.error || 'no agent')
assert(smart.agent!.mode === 'primary', 'mode primary')
assert(
  smart.agent!.disallowedTools?.includes('search-memory_*') === true,
  'keeps glob',
)
assert(
  !smart.agent!.disallowedTools?.includes(AGENT_TOOL_NAME),
  'primary does not auto-deny Agent tool',
)

const reserved = parseAgentFromMarkdown({
  filePath: 'x/plan.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: { name: 'Plan', description: 'bad', mode: 'primary' },
  body: 'nope',
})
assert(!!reserved.error, 'expected reserved primary name error')

const sub = parseAgentFromMarkdown({
  filePath: 'x/helper.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'helper',
    description: 'A helper',
  },
  body: 'Help.',
})
assert(sub.agent?.mode === 'subagent', 'default subagent')
assert(
  sub.agent!.disallowedTools?.includes(AGENT_TOOL_NAME) === true,
  'subagent auto-denies Agent',
)

assert(!!findPrimaryAgent([smart.agent!], 'reviewer'), 'findPrimary')
assert(findPrimaryAgent([sub.agent!], 'helper') === null, 'sub not primary')

const isolated = browserAgentSessionSection('isolated')
assert(isolated.includes('agent-only Chrome'), 'isolated names the profile')
assert(isolated.includes('browser_navigate'), 'isolated starts with navigate')
assert(!isolated.includes('Electron'), 'session is not a host-app CDP copy')
assert(
  !isolated.includes('Runtime.evaluate'),
  'CDP usage lives on the tool, not the session',
)
const extension = browserAgentSessionSection('extension')
assert(extension.includes('browser_tabs'), 'extension lists tabs first')
assert(
  extension.includes("user's signed-in Chrome"),
  'extension names user Chrome',
)
assert(extension.includes('browser_lock'), 'extension names lock for captcha')
assert(
  !extension.includes('Electron'),
  'extension session is not a host-app copy',
)
assert(
  !extension.includes('browser.mode'),
  'extension session does not tell the model to switch Chrome product',
)

const handoff = browserAgentSessionSection('isolated', {
  url: 'http://localhost:5173/login',
  title: 'Login',
  targetId: 'tab-9',
})
assert(handoff.includes('localhost:5173/login'), 'handoff names the open URL')
assert(handoff.includes('tab-9'), 'handoff names the tab')
assert(handoff.includes('Reuse'), 'handoff tells the model to reuse')

assert(
  CDP_SUMMARY.includes('Runtime.evaluate'),
  'CDP summary is findable via ToolSearch',
)
assert(
  !CDP_SUMMARY.includes('no snapshot ref'),
  'CDP summary does not send the model to evaluate when a ref is missing',
)
assert(
  CDP_DESCRIPTION.includes('Do not use CDP Input'),
  'CDP description states the Input.* denial',
)
assert(
  !CDP_DESCRIPTION.includes('Electron'),
  'CDP description is not a host-app copy',
)
assert(
  !CDP_DESCRIPTION.includes('DOM.getDocument'),
  'cdp tool description stays short; DOM tree denial is runtime policy',
)
assert(LOCK_DESCRIPTION.includes('unlock'), 'lock prompt names unlock')
assert(LOCK_DESCRIPTION.includes('lock'), 'lock prompt names lock')
assert(
  FILL_FORM_DESCRIPTION.includes('filled, skipped, or failed'),
  'fill_form reports per-field status',
)
assert(
  FILE_UPLOAD_DESCRIPTION.includes('omit') ||
    FILE_UPLOAD_DESCRIPTION.includes('Omit'),
  'file_upload treats a non-file ref as optional',
)
assert(
  FILE_UPLOAD_DESCRIPTION.includes('Do not click'),
  'file_upload forbids clicking a visible Upload',
)
assert(
  !CLICK_DESCRIPTION.includes('x/y') && CLICK_DESCRIPTION.includes('by ref'),
  'click is ref-only',
)
assert(
  MOUSE_CLICK_XY_DESCRIPTION.includes('visual-only') &&
    MOUSE_CLICK_XY_DESCRIPTION.includes('Do not use this as fallback') &&
    MOUSE_CLICK_XY_DESCRIPTION.includes('fresh viewport browser_screenshot'),
  'coordinate click is separate, screenshot-bound, and not a ref-click fallback',
)
assert(
  TYPE_DESCRIPTION.toLowerCase().includes('replace'),
  'type documents BaiX fill-replace default (no split type/fill)',
)
assert(
  !TYPE_DESCRIPTION.includes('do not reuse old refs'),
  'type does not repeat the snapshot primer',
)
assert(
  !WAIT_FOR_DESCRIPTION.includes('e12'),
  'wait_for does not repeat the snapshot primer',
)
assert(
  SNAPSHOT_DESCRIPTION.includes('better than screenshot'),
  'snapshot keeps its one-liner role',
)
assert(
  !SNAPSHOT_DESCRIPTION.includes('never full'),
  'snapshot does not forbid repeated full captures',
)
assert(
  !SNAPSHOT_DESCRIPTION.includes('at most once'),
  'snapshot does not cap full at once',
)
assert(
  !SNAPSHOT_DESCRIPTION.includes('Cursor'),
  'snapshot tool description carries no vendor branding',
)

const browserMd = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../.ai-agent/agents/browser.md',
  ),
  'utf8',
)
assert(
  /^omitProjectRules:\s*true\s*$/m.test(browserMd),
  'browser.md omits AGENTS.md / project rules',
)
assert(
  /memory:\s*\n\s*mode:\s*private\s*\n\s*scope:\s*local\s*\n\s*vocabulary:\s*external/.test(
    browserMd,
  ),
  'browser.md uses private local external memory',
)
assert(
  browserMd.includes('[ref=eN]'),
  'browser.md tells the agent to click latest snapshot refs',
)
assert(
  browserMd.includes('maxDepth 30'),
  'browser.md documents snapshot maxDepth 30',
)
assert(
  browserMd.includes('mode=full'),
  'browser.md documents snapshot mode=full',
)
assert(
  browserMd.includes('CSS only'),
  'browser.md documents snapshot selector is CSS, not a ref',
)
assert(
  browserMd.includes('replaces'),
  'browser.md documents browser_type replace semantics',
)
assert(
  !browserMd.replaceAll('Cursor defaults', '').includes('Cursor'),
  'browser.md carries no vendor branding',
)
assert(
  !browserMd.includes('never full'),
  'browser.md does not forbid repeated snapshots',
)
assert(
  browserMd.includes('Avoid rabbit holes'),
  'browser.md has avoid-rabbit-holes policy',
)
assert(
  browserMd.includes('four attempts'),
  'browser.md stops after about four attempts',
)
assert(
  /^ {2}- browser_mouse_click_xy\s*$/m.test(browserMd),
  'browser.md allowlists browser_mouse_click_xy',
)
assert(
  /^ {2}- browser_cdp\s*$/m.test(browserMd),
  'browser.md allowlists the ownership-scoped browser_cdp tool',
)
assert(
  browserMd.includes('main source of truth'),
  'browser.md keeps the snapshot-as-source-of-truth note',
)
assert(
  browserMd.includes('Do not use this as fallback') ||
    browserMd.includes('never a fallback for a failed ref click'),
  'browser.md forbids coordinate click as a ref-click fallback',
)
assert(
  !browserMd.includes('click a node'),
  'browser.md does not tell the model to click via evaluate',
)

const browserProfile = parseAgentFromMarkdown({
  filePath: 'x/browser.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'browser',
    description: 'Drive a browser',
    mode: 'primary',
    omitProjectRules: true,
    tools: 'Bash',
  },
  body: 'You are a Browser Automation specialist.',
})
assert(!!browserProfile.agent, browserProfile.error || 'no browser agent')
assert(
  browserProfile.agent!.omitProjectRules === true,
  'omitProjectRules parsed',
)

const withRules = await getSystemPromptForAgentProfile(
  browserProfile.agent!,
  process.cwd(),
  '# Agent instructions\nDo not commit secrets.',
  undefined,
  'test-model',
)
assert(
  !withRules.includes('Do not commit secrets'),
  'browser profile must not append AGENTS.md',
)
assert(
  !withRules.includes('# Agent instructions'),
  'browser profile must not append project rules heading',
)

const env = await computeSimpleEnvInfo('')
if (process.platform === 'win32') {
  assert(
    !env.includes('Shell: unknown'),
    'Windows env must not say Shell: unknown',
  )
  assert(
    env.includes('Git Bash') || env.includes('PowerShell'),
    'Windows env names the detected shell',
  )
}

console.log('primary agent parse checks passed')
