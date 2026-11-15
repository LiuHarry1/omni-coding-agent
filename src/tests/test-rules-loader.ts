import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  loadConditionalRulesForPaths,
  loadProjectRules,
  loadUserRules,
} from '../utils/rules-loader.js'
import { runWithRequestScope } from '../utils/workspace/request-scope.js'
import {
  createAttachmentMessage,
  getAttachments,
} from '../utils/attachments.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'
import type { ToolUseContext } from '../core/types.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-loader-'))
const repo = path.join(tmp, 'repo')
const nested = path.join(repo, 'packages', 'app')
const appDir = path.join(repo, '.ai-agent')
const rulesDir = path.join(appDir, 'rules')
const outside = path.join(tmp, 'outside.md')

fs.mkdirSync(path.join(rulesDir, 'deep'), { recursive: true })
fs.mkdirSync(nested, { recursive: true })
fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
execFileSync('git', ['init', '--quiet'], { cwd: repo })

fs.writeFileSync(
  path.join(repo, 'AGENTS.md'),
  'root-entry\n@./docs/shared.md\n@../outside.md\n',
)
fs.writeFileSync(path.join(repo, 'docs', 'shared.md'), 'inside-include\n')
fs.writeFileSync(outside, 'outside-secret\n')
fs.writeFileSync(path.join(appDir, 'AGENTS.md'), 'root-app-entry\n')
fs.writeFileSync(path.join(rulesDir, 'a.md'), 'root-topic-rule\n')
fs.writeFileSync(
  path.join(rulesDir, 'conditional.md'),
  `---
paths:
  - packages/app/src/**/*.ts
---
typescript-conditional-rule
`,
)
fs.writeFileSync(
  path.join(rulesDir, 'deep', 'topic.md'),
  'recursive-topic-rule\n',
)
fs.writeFileSync(path.join(appDir, 'AGENTS.local.md'), 'root-app-local\n')
fs.writeFileSync(path.join(repo, 'AGENTS.local.md'), 'root-local\n')
fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'nested-entry\n')
fs.writeFileSync(path.join(nested, 'AGENTS.local.md'), 'nested-local\n')
const targetFile = path.join(nested, 'src', 'feature.ts')
fs.mkdirSync(path.dirname(targetFile), { recursive: true })
fs.writeFileSync(targetFile, 'export const feature = true\n')

try {
  fs.symlinkSync(
    path.join(repo, 'docs', 'shared.md'),
    path.join(rulesDir, 'dup.md'),
  )
  fs.symlinkSync(rulesDir, path.join(rulesDir, 'loop'))
} catch {
  // Symlink creation may be unavailable on restricted Windows test hosts.
}

const project = loadProjectRules(nested)
const ordered = [
  'root-entry',
  'inside-include',
  'root-app-entry',
  'root-topic-rule',
  'recursive-topic-rule',
  'root-app-local',
  'root-local',
  'nested-entry',
  'nested-local',
]
let previous = -1
for (const marker of ordered) {
  const index = project.indexOf(marker)
  assert.ok(index > previous, `${marker} loaded in incorrect priority order`)
  previous = index
}
assert.equal(
  project.match(/inside-include/g)?.length,
  1,
  'realpath aliases must be deduplicated',
)
assert.ok(
  !project.includes('outside-secret'),
  'external include must be denied',
)
assert.ok(
  !project.includes('typescript-conditional-rule'),
  'paths rule must stay out of static prompt',
)
console.log(
  'ok: project rule order, recursion, include boundary, symlink dedup',
)

const conditional = loadConditionalRulesForPaths(nested, [targetFile])
assert.equal(conditional.length, 1)
assert.ok(conditional[0]!.content.includes('typescript-conditional-rule'))
assert.equal(
  loadConditionalRulesForPaths(nested, [path.join(nested, 'README.md')]).length,
  0,
)

const toolUseContext = {
  cwd: nested,
  session: {
    id: 'conditional-rules-test',
    permissionMode: { mode: 'agent' },
    messages: [],
  },
  readFileState: new Map([
    [targetFile, { content: '', timestamp: Date.now() }],
  ]),
  options: { tools: {} },
  conditionalRulesEnabled: true,
} as unknown as ToolUseContext
const firstAttachments = await getAttachments(null, toolUseContext, [])
const conditionalAttachment = firstAttachments.find(
  attachment => attachment.type === 'conditional_rules',
)
assert.ok(
  conditionalAttachment,
  'matching rule must become a post-tool attachment',
)
const attachmentMessage = createAttachmentMessage(conditionalAttachment)
const expanded = expandAttachmentMessagesForAPI([attachmentMessage])
assert.ok(
  JSON.stringify(expanded).includes('typescript-conditional-rule'),
  'conditional attachment must reach the model',
)
const duplicateAttachments = await getAttachments(null, toolUseContext, [
  attachmentMessage,
])
assert.ok(
  !duplicateAttachments.some(
    attachment => attachment.type === 'conditional_rules',
  ),
  'conditional rule must not be injected twice before compaction',
)
const remoteAttachments = await getAttachments(
  null,
  { ...toolUseContext, conditionalRulesEnabled: false },
  [],
)
assert.ok(
  !remoteAttachments.some(
    attachment => attachment.type === 'conditional_rules',
  ),
  'Remote/omitted project rules must not load host conditional rules',
)
console.log('ok: paths rules load lazily after matching file tools')

const alice = path.join(tmp, 'tenants', 'alice')
const bob = path.join(tmp, 'tenants', 'bob')
fs.mkdirSync(path.join(alice, '.ai-agent'), { recursive: true })
fs.mkdirSync(bob, { recursive: true })
fs.mkdirSync(path.join(alice, '.ai-agent', 'rules'), { recursive: true })
fs.writeFileSync(path.join(alice, 'own.md'), 'alice-own-include\n')
fs.writeFileSync(path.join(bob, 'secret.md'), 'bob-secret\n')
const aliceTarget = path.join(alice, 'src', 'a.ts')
const bobTarget = path.join(bob, 'src', 'b.ts')
fs.mkdirSync(path.dirname(aliceTarget), { recursive: true })
fs.mkdirSync(path.dirname(bobTarget), { recursive: true })
fs.writeFileSync(aliceTarget, 'export const a = 1\n')
fs.writeFileSync(bobTarget, 'export const b = 1\n')
fs.writeFileSync(
  path.join(alice, '.ai-agent', 'rules', 'typescript.md'),
  `---
paths: "**/*.ts"
---
alice-typescript-rule
`,
)
fs.writeFileSync(
  path.join(alice, '.ai-agent', 'AGENTS.md'),
  'alice-rules\n@../own.md\n@../../bob/secret.md\n',
)

const previousAuth = process.env.AUTH_ENABLED
process.env.AUTH_ENABLED = 'true'
try {
  const aliceRules = runWithRequestScope({ agentHome: alice, cwd: alice }, () =>
    loadUserRules(),
  )
  assert.ok(aliceRules.includes('alice-rules'))
  assert.ok(aliceRules.includes('alice-own-include'))
  assert.ok(!aliceRules.includes('bob-secret'))
  assert.ok(!aliceRules.includes('alice-typescript-rule'))
  const ownConditional = runWithRequestScope(
    { agentHome: alice, cwd: alice },
    () => loadConditionalRulesForPaths(alice, [aliceTarget]),
  )
  assert.ok(
    ownConditional.some(rule => rule.content.includes('alice-typescript-rule')),
  )
  const crossTenantConditional = runWithRequestScope(
    { agentHome: alice, cwd: alice },
    () => loadConditionalRulesForPaths(alice, [bobTarget]),
  )
  assert.equal(crossTenantConditional.length, 0)
  const crossTenantProjectRules = runWithRequestScope(
    { agentHome: alice, cwd: alice },
    () => loadProjectRules(bob),
  )
  assert.equal(crossTenantProjectRules, '')
  console.log('ok: SSO user-rule includes stay inside tenant home')
} finally {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('All rules-loader checks passed.')
