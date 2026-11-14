import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'
import {
  getToolResultFilePath,
  registerSessionLocation,
} from '../../core/session-paths.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { isPersistedReference } from './index.js'
import { enforceToolResultBudget } from './message-budget.js'

const SESSION = 'budget-session'
const previousAuth = process.env.AUTH_ENABLED
const cleanup: string[] = []

afterEach(() => {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function inScope<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-budget-'))
  cleanup.push(home)
  process.env.AUTH_ENABLED = 'true'
  registerSessionLocation(SESSION, {
    projectKey: 'budget-test',
    agentHome: home,
  })
  return runWithRequestScope({ agentHome: home, cwd: home }, fn)
}

const result = (toolCallId: string, chars: number, toolName = 'Grep') => ({
  toolCallId,
  toolName,
  result: `${toolCallId}:`.padEnd(chars, 'x'),
})

describe('enforceToolResultBudget', () => {
  it('leaves results alone when together they fit', () => {
    inScope(() => {
      const results = [result('a', 400), result('b', 500)]

      expect(enforceToolResultBudget(results, SESSION, 1_000)).toBe(results)
    })
  })

  it('moves the largest results to disk until the rest fits', () => {
    inScope(() => {
      const results = [
        result('small', 3_000),
        result('largest', 9_000),
        result('large', 8_000),
        result('medium', 5_000),
      ]

      const bounded = enforceToolResultBudget(results, SESSION, 10_000)

      // 25k total: dropping 9k and 8k leaves 8k inline, within the limit.
      expect(bounded.map(r => isPersistedReference(r.result))).toEqual([
        false,
        true,
        true,
        false,
      ])
      expect(bounded[0]).toBe(results[0])
      expect(bounded[1]!.result).toContain('Output too large')
      expect(bounded[1]!.result.length).toBeLessThan(3_000)
      expect(
        fs.readFileSync(getToolResultFilePath(SESSION, 'largest'), 'utf-8'),
      ).toBe(results[1]!.result)
      // The input is not modified.
      expect(results[1]!.result).toHaveLength(9_000)
    })
  })

  it('neither counts nor moves Read output, images, or existing references', () => {
    inScope(() => {
      const read = result('read', 50_000, FILE_READ_TOOL_NAME)
      const image = { ...result('image', 50_000), resultBlocks: [{}] }
      const reference = {
        ...result('ref', 10),
        result: `<persisted-output path="/x" tool="Grep" chars="90000">\n${'x'.repeat(50_000)}`,
      }
      const results = [read, image, reference, result('grep', 900)]

      expect(enforceToolResultBudget(results, SESSION, 1_000)).toBe(results)
    })
  })

  it('does nothing without a session to store files under', () => {
    const results = [result('a', 900), result('b', 900)]

    expect(enforceToolResultBudget(results, undefined, 1_000)).toBe(results)
  })
})
