import type {
  AgentContext,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RunAgentFn } from '../core/types.js'
import {
  handlePlanModeTransition,
  transitionPermissionMode,
} from '../utils/permissions/permission-mode.js'
import { appendModeChange } from '../session/index.js'
import { acpModeToExternal, sessionModeState } from './modes.js'
import { promptBlocksToUserTurn } from './prompt-input.js'
import { AcpSessionRegistry, runAcpPromptTurn } from './turn-runner.js'
import { AcpTurnSink } from './translate-outbound.js'
import { APP_NAME } from '../brand.js'
import { historyNotifications } from './history.js'

export class BaizeAcpAgent {
  readonly #runAgent: RunAgentFn
  readonly #defaultCwd: string
  readonly #sessions = new AcpSessionRegistry()

  constructor(runAgent: RunAgentFn, defaultCwd: string) {
    this.#runAgent = runAgent
    this.#defaultCwd = defaultCwd
  }

  initialize(_params: InitializeRequest): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: APP_NAME, version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: { http: true, sse: true },
      },
    }
  }

  authenticate(_params: AuthenticateRequest): AuthenticateResponse {
    return {}
  }

  newSession(params: NewSessionRequest): NewSessionResponse {
    const cwd = params.cwd || this.#defaultCwd
    const record = this.#sessions.create(cwd)
    return {
      sessionId: record.session.id,
      modes: sessionModeState(record.session),
    }
  }

  /** Resume a saved session, replaying its conversation to the client first. */
  async loadSession(
    params: LoadSessionRequest,
    client: AgentContext,
  ): Promise<LoadSessionResponse> {
    const cwd = params.cwd || this.#defaultCwd
    const record = this.#sessions.load(params.sessionId, cwd)
    if (!record) throw new Error(`Session not found: ${params.sessionId}`)
    for (const notification of historyNotifications(
      params.sessionId,
      record.session.messages,
      cwd,
    )) {
      await client.notify(methods.client.session.update, notification)
    }
    return { modes: sessionModeState(record.session) }
  }

  setSessionMode(params: SetSessionModeRequest): SetSessionModeResponse {
    const record = this.#sessions.get(params.sessionId)
    if (!record) {
      throw new Error(`Session not found: ${params.sessionId}`)
    }
    const external = acpModeToExternal(params.modeId)
    if (!external) {
      throw new Error(`Unknown mode: ${params.modeId}`)
    }
    const from = record.session.permissionMode.mode
    if (from !== external) {
      handlePlanModeTransition(from, external, record.session)
      record.session.permissionMode = transitionPermissionMode(
        from,
        external,
        record.session.permissionMode,
      )
      appendModeChange(record.session.id, record.session)
    }
    return {}
  }

  async prompt(
    params: PromptRequest,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const record = this.#sessions.get(params.sessionId)
    if (!record) {
      throw new Error(`Session not found: ${params.sessionId}`)
    }

    const { text, images } = promptBlocksToUserTurn(params.prompt)
    if (!text && !images?.length) {
      return { stopReason: 'end_turn' }
    }

    const sink = new AcpTurnSink(client, params.sessionId, record.cwd)
    const result = await runAcpPromptTurn({
      record,
      message: text || '(image attachment)',
      images,
      runAgent: this.#runAgent,
      sink,
      signal,
    })

    if (result.stopReason === 'refusal' && result.error) {
      throw new Error(result.error)
    }

    return { stopReason: result.stopReason }
  }

  cancel(params: CancelNotification): void {
    this.#sessions.cancel(params.sessionId)
  }

  async dispose(): Promise<void> {
    /* pool cleanup reserved for MCP / session persistence */
  }
}
