/**
 * AgentClient — typed HTTP client for the coding agent backend.
 *
 * One class, three thin layers:
 *
 *   - Discovery:   listSkills(), listAgents(), health()
 *   - Direct:      invokeSkill(name, …) — JSON for inline, async-iter for fork
 *   - Free-form:   chat({...}) / chatComplete({...})
 *
 * Streaming methods return an `AsyncIterable<AgentEvent>`. Buffered
 * methods resolve to plain objects. Works in Node ≥18, browsers, Bun,
 * edge runtimes — anywhere `fetch` + `ReadableStream` exist.
 */

import { mintJwt } from './auth.js'
import { AgentClientError } from './errors.js'
import { parseSSE } from './sse.js'
import type {
  AgentEvent,
  AgentsListResponse,
  ChatJSONResult,
  ChatRequest,
  DurableRun,
  StartedChatRun,
  SkillInvokeRequest,
  SkillInvokeResult,
  SkillsListResponse,
} from './types.js'

export interface AgentClientOptions {
  baseURL: string
  token?: string
  jwtSecret?: string
  email?: string
  username?: string
  role?: string
  tokenTtl?: number
  defaultWorkspace?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}

export class AgentClient {
  readonly #baseURL: string
  readonly #defaultWorkspace?: string
  readonly #headers: Record<string, string>
  readonly #fetch: typeof fetch
  readonly #token?: string

  constructor(opts: AgentClientOptions) {
    if (!opts.baseURL) throw new Error('AgentClient: baseURL is required')
    this.#baseURL = opts.baseURL.replace(/\/$/, '')
    this.#defaultWorkspace = opts.defaultWorkspace
    this.#headers = opts.headers ?? {}
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
    if (!this.#fetch) {
      throw new Error(
        'AgentClient: no fetch available; pass `fetch` in options on runtimes <Node18.',
      )
    }

    if (opts.token) {
      this.#token = opts.token
    } else if (opts.jwtSecret) {
      if (!opts.email) {
        throw new Error(
          'AgentClient: email is required when minting from jwtSecret',
        )
      }
      this.#token = mintJwt(opts.jwtSecret, opts.email, {
        username: opts.username,
        role: opts.role,
        ttlSeconds: opts.tokenTtl,
      })
    }
  }

  async health(): Promise<{ ok: boolean }> {
    return this.#getJSON<{ ok: boolean }>('/health')
  }

  async listSkills(workspace?: string): Promise<SkillsListResponse> {
    return this.#getJSON<SkillsListResponse>(
      this.#workspacePath('/skills', workspace),
    )
  }

  async listAgents(workspace?: string): Promise<AgentsListResponse> {
    return this.#getJSON<AgentsListResponse>(
      this.#workspacePath('/agents', workspace),
    )
  }

  async invokeSkill(
    name: string,
    req: SkillInvokeRequest = {},
  ): Promise<SkillInvokeResult> {
    return this.#postJSON<SkillInvokeResult>(
      `/skills/${encodeURIComponent(name)}/invoke?stream=false`,
      this.#skillBody(req),
    )
  }

  invokeSkillStream(
    name: string,
    req: SkillInvokeRequest = {},
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    return this.#postSSE(
      `/skills/${encodeURIComponent(name)}/invoke`,
      this.#skillBody(req),
      signal,
    )
  }

  async chatComplete(req: ChatRequest): Promise<ChatJSONResult> {
    return this.#postJSON<ChatJSONResult>(
      '/chat?stream=false',
      this.#chatBody(req),
    )
  }

  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    return this.#postSSE('/chat', this.#chatBody(req), signal)
  }

  /** Start a streaming chat and expose its stable Run identity immediately. */
  async startChatRun(
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<StartedChatRun> {
    const res = await this.#openPostSSE('/chat', this.#chatBody(req), signal)
    const runId = res.headers.get('x-run-id')
    if (!runId) {
      throw new AgentClientError(
        'Server did not return X-Run-Id',
        res.status,
        null,
      )
    }
    return {
      run_id: runId,
      session_id: res.headers.get('x-session-id') ?? undefined,
      events: this.#eventsFromResponse(res, signal, runId),
    }
  }

  getRun(runId: string): Promise<DurableRun> {
    return this.#getJSON<DurableRun>(`/runs/${encodeURIComponent(runId)}`)
  }

  streamRun(
    runId: string,
    afterSeq = 0,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const qs = afterSeq > 0 ? `?after_seq=${afterSeq}` : ''
    return this.#getSSE(
      `/runs/${encodeURIComponent(runId)}/stream${qs}`,
      signal,
      afterSeq > 0 ? String(afterSeq) : undefined,
    )
  }

  cancelRun(runId: string): Promise<{ ok: boolean; run_id: string }> {
    return this.#postJSON<{ ok: boolean; run_id: string }>(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      {},
    )
  }

  #workspacePath(path: string, workspace?: string): string {
    const ws = workspace ?? this.#defaultWorkspace
    return ws ? `${path}?workspace=${encodeURIComponent(ws)}` : path
  }

  #skillBody(req: SkillInvokeRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      workspace: req.workspace ?? this.#defaultWorkspace,
    }
    if (req.arguments !== undefined) body.arguments = req.arguments
    return body
  }

  #chatBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      message: req.message,
      workspace: req.workspace ?? this.#defaultWorkspace,
    }
    if (req.session_id) body.session_id = req.session_id
    if (req.images?.length) body.images = req.images
    if (req.mode) body.mode = req.mode
    if (req.agentType !== undefined) body.agentType = req.agentType
    if (req.environmentId) body.environmentId = req.environmentId
    return body
  }

  #authHeaders(): Record<string, string> {
    const h = { ...this.#headers }
    if (this.#token) h.Authorization = `Bearer ${this.#token}`
    return h
  }

  async #getJSON<T>(path: string): Promise<T> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.#authHeaders() },
    })
    return this.#parseJSON<T>(res)
  }

  async #postJSON<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.#authHeaders(),
      },
      body: JSON.stringify(body),
    })
    return this.#parseJSON<T>(res)
  }

  async #parseJSON<T>(res: Response): Promise<T> {
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch (e) {
      throw new AgentClientError(
        `Invalid JSON from server: ${(e as Error).message}`,
        res.status,
        text,
      )
    }
    if (!res.ok) {
      const { message, body } = errorFromBody(parsed, res.status)
      throw new AgentClientError(message, res.status, body)
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed as T
    }
    return { result: parsed } as T
  }

  async *#postSSE(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const res = await this.#openPostSSE(path, body, signal)
    const runId = res.headers.get('x-run-id') ?? undefined
    yield* this.#eventsFromResponse(res, signal, runId)
  }

  async #openPostSSE(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.#authHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const { message, body: errBody } = parseErrorText(text, res.status)
      throw new AgentClientError(message, res.status, errBody)
    }
    if (!res.body) {
      throw new AgentClientError('Empty response body', res.status, null)
    }
    return res
  }

  async *#eventsFromResponse(
    res: Response,
    signal?: AbortSignal,
    runId?: string,
  ): AsyncGenerator<AgentEvent> {
    if (!res.body) {
      throw new AgentClientError('Empty response body', res.status, null)
    }
    for await (const event of parseSSE(res.body, signal)) {
      if (runId) event.run_id = runId
      yield event
    }
  }

  async *#getSSE(
    path: string,
    signal?: AbortSignal,
    lastEventId?: string,
  ): AsyncGenerator<AgentEvent> {
    const res = await this.#fetch(this.#baseURL + path, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        ...this.#authHeaders(),
      },
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const { message, body: errBody } = parseErrorText(text, res.status)
      throw new AgentClientError(message, res.status, errBody)
    }
    if (!res.body) {
      throw new AgentClientError('Empty response body', res.status, null)
    }
    yield* parseSSE(res.body, signal)
  }
}

function errorFromBody(parsed: unknown, status: number) {
  return { message: errorMessage(parsed, status), body: parsed }
}

function parseErrorText(text: string, status: number) {
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* keep raw text */
  }
  return errorFromBody(parsed, status)
}

function errorMessage(parsed: unknown, status: number): string {
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof (parsed as { error?: unknown }).error === 'string'
  ) {
    return (parsed as { error: string }).error
  }
  return `HTTP ${status}`
}
