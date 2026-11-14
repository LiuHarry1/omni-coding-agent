/**
 * Unit smoke for task_id / TaskOutput / LocalShellTask (no live LLM).
 * Run: npx tsx src/tests/test-bash-tasks.ts
 */
import assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import { generateTaskId, isTerminalTaskStatus } from '../Task.js'
import {
  _resetTaskOutputDirForTest,
  appendTaskOutput,
  getTaskOutput,
  getTaskOutputPath,
  initTaskOutput,
  setTaskSessionId,
} from '../utils/task/diskOutput.js'
import { formatTaskOutput } from '../utils/task/outputFormatting.js'
import { resolveFileInCwd } from '../utils/read/index.js'
import {
  isReadableInternalPath,
  getProjectsRoot,
  registerSessionLocation,
  computeProjectKey,
} from '../core/session-paths.js'
import { resolveAgentHome } from '../utils/request-scope.js'
import { spawnShellTask } from '../tasks/LocalShellTask/LocalShellTask.js'
import { stopTask } from '../tasks/stopTask.js'
import { getTask, clearSessionTasks } from '../utils/task/framework.js'
import { dequeueAll } from '../utils/messageQueueManager.js'

async function main() {
  _resetTaskOutputDirForTest()
  const sid = 'test-session-tasks'
  registerSessionLocation(sid, {
    projectKey: computeProjectKey(undefined, process.cwd()),
    agentHome: resolveAgentHome(),
  })
  setTaskSessionId(sid)
  clearSessionTasks(sid)

  const id = generateTaskId('local_bash')
  assert.match(id, /^b[0-9a-z]{8}$/)
  assert.equal(isTerminalTaskStatus('running'), false)
  assert.equal(isTerminalTaskStatus('completed'), true)

  initTaskOutput(id)
  appendTaskOutput(id, 'hello\n')
  appendTaskOutput(id, 'world\n')
  assert.equal(getTaskOutput(id), 'hello\nworld\n')
  assert.ok(getTaskOutputPath(id).endsWith(`${id}.output`))

  // Read must allow session task outputs outside project cwd (project-temp).
  const outPath = getTaskOutputPath(id)
  assert.equal(isReadableInternalPath(outPath), true)
  const foreignCwd = path.resolve('/tmp/other-project-not-agent')
  const resolved = resolveFileInCwd(foreignCwd, outPath)
  assert.ok(!('error' in resolved), (resolved as { error?: string }).error)
  if (!('error' in resolved)) {
    assert.equal(resolved.abs, path.normalize(outPath))
  }
  const absOutside = path.resolve(os.tmpdir(), 'not-agent-passwd.txt')
  const blocked = resolveFileInCwd(foreignCwd, absOutside)
  assert.ok(!('error' in blocked), 'resolve never fails for paths outside cwd')
  if (!('error' in blocked)) {
    assert.equal(blocked.abs, path.normalize(absOutside))
  }
  assert.equal(isReadableInternalPath(getProjectsRoot()), true)

  const big = 'x'.repeat(40_000)
  const fmt = formatTaskOutput(big, id)
  assert.equal(fmt.wasTruncated, true)
  assert.ok(fmt.content.includes('Truncated'))

  const handle = await spawnShellTask({
    command: 'echo task-ok && sleep 0.3 && echo done',
    description: 'echo test',
    sessionId: 'test-session-tasks',
    cwd: process.cwd(),
    shell: 'bash',
  })
  assert.match(handle.taskId, /^b[0-9a-z]{8}$/)
  const running = getTask('test-session-tasks', handle.taskId)
  assert.ok(running)
  assert.equal(running!.status, 'running')

  // Wait for completion notification
  let notified = false
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100))
    const n = dequeueAll('test-session-tasks')
    if (n.length > 0) {
      assert.equal(n[0]!.mode, 'task-notification')
      assert.ok(n[0]!.value.includes(`<task-id>${handle.taskId}</task-id>`))
      assert.match(n[0]!.value, /<status>(completed|failed)<\/status>/)
      assert.ok(n[0]!.value.includes('<task-notification>'))
      notified = true
      break
    }
  }
  assert.ok(notified, 'expected task-notification')
  const out = getTaskOutput(handle.taskId)
  assert.ok(out.includes('task-ok') || out.includes('done'), out)

  // Stop a long-running task
  const bg = await spawnShellTask({
    command: 'sleep 30',
    description: 'long sleep',
    sessionId: 'test-session-tasks',
    cwd: process.cwd(),
    shell: 'bash',
  })
  await new Promise(r => setTimeout(r, 200))
  const stop = await stopTask('test-session-tasks', bg.taskId)
  assert.ok(stop.message.includes('stopped'))
  const stopped = getTask('test-session-tasks', bg.taskId)
  assert.equal(stopped?.status, 'killed')

  console.log('All bash-task checks passed.')
  clearSessionTasks('test-session-tasks')
  _resetTaskOutputDirForTest()
  // Give kill a moment then exit
  setTimeout(() => process.exit(0), 300)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
