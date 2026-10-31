/**
 * Glue between `runSkillFork` and a transport (SSE HTTP or stdio NDJSON).
 */

import type { ServerResponse } from 'http'
import { EventBus } from '../core/event-bus.js'
import { createSSETransport } from '../server/sse-transport.js'
import { createWireEmitter } from '../core/wire-emitter.js'
import {
  createFilesystemPermissionContext,
  settingsPermissionOpts,
} from '../utils/permissions/filesystem.js'
import { registerSubagents } from '../tools/AgentTool/index.js'
import { defaultRegistry } from '../tools.js'
import type {
  AppConfig,
  IProvider,
  ModelRegistry,
  RunAgentFn,
  SSETransport,
} from '../core/types.js'
import { createModelRegistry } from '../core/llm/index.js'
import { runSkillFork } from './run-fork.js'
import type { SkillDefinition } from './types.js'

export interface RespondSkillForkOptions {
  /** HTTP response for SSE mode. Omit when using `stdioTransport`. */
  res?: ServerResponse
  /** Pre-created stdio transport (headless CLI). */
  stdioTransport?: SSETransport
  skill: SkillDefinition
  combined: string
  cwd: string
  runAgent: RunAgentFn
  provider: IProvider
  models?: ModelRegistry
  config: AppConfig
  wantsStream: boolean
  sseHeaders?: Record<string, string>
  jsonMeta?: Record<string, unknown>
  sessionId?: string
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export async function respondSkillFork(
  opts: RespondSkillForkOptions,
): Promise<string | undefined> {
  const {
    res,
    stdioTransport,
    skill,
    combined,
    cwd,
    runAgent,
    provider,
    models: modelsOpt,
    config,
    wantsStream,
    sseHeaders,
    jsonMeta,
    sessionId = '',
  } = opts

  const models = modelsOpt ?? createModelRegistry(config.models)
  const { activeAgents } = await registerSubagents(defaultRegistry, cwd)
  const targetAgentType = skill.agent ?? 'general_purpose'
  const targetAgent = activeAgents.find(a => a.agentType === targetAgentType)
  if (!targetAgent) {
    const message = `Skill '${skill.name}' fork target '${targetAgentType}' not found`
    if (res) {
      sendJSON(res, 400, {
        error: message,
        available: activeAgents.map(a => a.agentType),
      })
      return undefined
    }
    throw new Error(message)
  }

  const eventBus = new EventBus()
  const toolEnablement = { disabledTools: config.disabledTools }

  const runOpts = {
    skill,
    combined,
    cwd,
    runAgent,
    registry: defaultRegistry,
    activeAgents,
    eventBus,
    wire: createWireEmitter({ emit() {} }, sessionId),
    toolEnablement,
    provider,
    models,
    compaction: config.compaction,
    sessionId,
    permissionContext: createFilesystemPermissionContext(
      cwd,
      settingsPermissionOpts(config.permissions),
    ),
  }

  if (wantsStream) {
    const transport =
      stdioTransport ?? createSSETransport(res!, sseHeaders ?? {})
    const wire = createWireEmitter(transport, sessionId)
    runOpts.wire = wire
    wire.skillStart({
      skill: skill.name,
      agent_type: targetAgent.agentType,
      workspace: cwd,
    })
    try {
      const result = await runSkillFork(runOpts)
      wire.textDelta(result)
      wire.finish('skill_fork')
      return result
    } catch (e) {
      wire.error((e as Error).message)
      return undefined
    } finally {
      if (res) transport.end()
    }
  }

  if (!res) return undefined

  try {
    const result = await runSkillFork(runOpts)
    sendJSON(res, 200, {
      skill: skill.name,
      context: 'fork',
      agentType: targetAgent.agentType,
      workspace: cwd,
      result,
      ...jsonMeta,
    })
    return result
  } catch (e) {
    sendJSON(res, 500, { error: (e as Error).message, ...jsonMeta })
    return undefined
  }
}
