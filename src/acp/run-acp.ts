import { Readable, Writable } from 'node:stream'
import {
  agent,
  methods,
  ndJsonStream,
  type AgentConnection,
  type AgentContext,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import type { RunAgentFn } from '../core/types.js'
import { BaizeAcpAgent } from './baize-acp-agent.js'

export function runAcp(
  runAgent: RunAgentFn,
  defaultCwd: string,
): {
  connection: AgentConnection
  agent: BaizeAcpAgent
} {
  const output = Writable.toWeb(process.stdout)
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)

  const baizeAgent = new BaizeAcpAgent(runAgent, defaultCwd)
  const connection = agent({ name: 'baize-agent' })
    .onRequest(methods.agent.initialize, ctx =>
      baizeAgent.initialize(ctx.params),
    )
    .onRequest(methods.agent.authenticate, ctx =>
      baizeAgent.authenticate(ctx.params),
    )
    .onRequest(methods.agent.session.new, ctx =>
      baizeAgent.newSession(ctx.params),
    )
    .onRequest(methods.agent.session.load, ctx =>
      baizeAgent.loadSession(ctx.params, ctx.client),
    )
    .onRequest(methods.agent.session.setMode, ctx =>
      baizeAgent.setSessionMode(ctx.params),
    )
    .onRequest(methods.agent.session.prompt, ctx =>
      runPromptWithCancellation(baizeAgent, ctx.params, ctx.client, ctx.signal),
    )
    .onNotification(methods.agent.session.cancel, ctx =>
      baizeAgent.cancel(ctx.params),
    )
    .connect(stream)

  return { connection, agent: baizeAgent }
}

function runPromptWithCancellation(
  baizeAgent: BaizeAcpAgent,
  params: PromptRequest,
  client: AgentContext,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const onAbort = () => {
    baizeAgent.cancel({ sessionId: params.sessionId })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return baizeAgent.prompt(params, client, signal).finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
}
