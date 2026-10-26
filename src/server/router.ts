import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { createWorkspaceRouter } from './workspace/router.js'
import { createSkillsApi } from './skills-api.js'
import { createExecutionRouter } from './routes/execution.js'
import { createMarketplaceRouter } from './marketplace/router.js'
import { getDefaultWorkspace } from '../core/workspace.js'
import { defaultRegistry } from '../tools.js'
import { registerBuiltinSubagents } from '../tools/AgentTool/index.js'
import { listSlashCommands } from '../commands/dispatcher.js'
import { loadPluginsOverview } from '../commands/slashRegistry.js'
import { answerQuestion } from '../core/brokers/question-broker.js'
import { answerPermission } from '../core/brokers/permission-broker.js'
import { answerPlanApproval } from '../core/brokers/plan-approval-broker.js'
import { getPlanFilePath } from '../utils/plans.js'
import { readBody, sendJSON, setCORS } from './http.js'
import { isBrowserLive } from '../browser/manager.js'
import {
  anyUserHasControl,
  getUserHasControl,
  setUserHasControl,
  setUserHasControlEverywhere,
} from '../browser/session-flags.js'
import { loadWorkspaceContributions } from '../core/workspace-load.js'
import { findPrimaryAgent } from '../tools/AgentTool/mergeAgents.js'
import {
  applyPickerDefaultsToSession,
  loadResolvedAgentPicker,
  pickerAgentTypeError,
  pickerModeError,
} from '../core/agent-picker-workspace.js'
import {
  handlePlanModeTransition,
  isValidExternalMode,
  transitionPermissionMode,
} from '../core/permission-mode.js'
import {
  authenticateRequest,
  getUsersRoot,
  isAuthEnabled,
  isSuperUser,
  AuthError,
  type AuthedRequest,
} from './auth/identity.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import { serveStaticFile } from './static.js'
import { stripMountPath } from './public-base.js'
import {
  getMCPManagerForServers,
  initMcpLifecycle,
  invalidateMCPManagersForCwd,
} from '../core/mcp-lifecycle.js'
import { getLspStatusForCwd } from '../services/lsp/manager.js'
import { getExecutionPlane } from '../execution/bootstrap.js'
import { WorkerExecutionBackend } from '../execution/worker-execution-backend.js'
import { initCodePlugins } from '../core/plugins/index.js'
import { handleChat } from './routes/chat.js'
import { handleScheduledTasks } from './routes/scheduled-tasks.js'
import {
  handleWorkspaceReset,
  isWorkspaceResetting,
} from './routes/workspace-reset.js'
import { handleSessionLive } from './session-live.js'
import { getRunAgent } from '../agent-lazy.js'
import { abortTool } from '../core/tool-abort-registry.js'
import { abortTurn } from '../core/turn-abort-registry.js'
import {
  getSafeSettings,
  parseWritableScope,
  patchSettings,
  resolveEffectiveSettings,
  setMCPServer,
} from '../core/settings-manager.js'
import { resolveSettingsRequestCwd } from './request-cwd.js'
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  appendModeChange,
  appendAgentChange,
  canAccessSession,
} from './session.js'
import { sessionJsonlToUIMessages } from './session-ui.js'
import type {
  RouterOptions,
  MCPServerConfig,
  AppConfig,
  RunAgentFn,
} from '../core/types.js'

registerBuiltinSubagents(defaultRegistry)
initCodePlugins(defaultRegistry).catch(err => {
  console.error(`[plugins] code plugin init failed: ${err.message}`)
})
initMcpLifecycle()

async function getMCPStatusForCwd(
  cwd: string,
  mcpServers: Record<string, import('../core/types.js').MCPServerConfig>,
) {
  const manager = await getMCPManagerForServers(cwd, mcpServers)
  return manager.getStatus()
}

export function createRouter({ staticDir }: RouterOptions) {
  const workspaceRouter = createWorkspaceRouter({
    root: getDefaultWorkspace(),
    resolveRoot: req => {
      const authed = req as AuthedRequest
      if (isSuperUser(authed.user)) return getUsersRoot()
      return authed.userWorkspace
    },
  })
  const lazyRunAgent: RunAgentFn = async (...args) => {
    const runAgent = await getRunAgent()
    return runAgent(...args)
  }
  const skillsApi = createSkillsApi({ runAgent: lazyRunAgent })
  const executionRouter = createExecutionRouter()
  const marketplaceRouter = createMarketplaceRouter()

  return async (req: IncomingMessage, res: ServerResponse) => {
    setCORS(res, req)

    req.url = stripMountPath(req.url)
    const { method, url } = req
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (method === 'GET' && url === '/health') {
      sendJSON(res, 200, { status: 'ok' })
      return
    }

    // ── Auth gate (only when AUTH_ENABLED=true) ──────────────────────────
    // Verifies the bearer token and pins `req.userWorkspace`. Everything
    // below this line is protected; `/health` and OPTIONS above are not.
    // Under AUTH, bind logical agent HOME (ALS) once for the whole request.
    const authed = req as AuthedRequest
    if (isAuthEnabled()) {
      try {
        authenticateRequest(authed)
      } catch (e) {
        const err = e as AuthError
        sendJSON(res, err.statusCode ?? 401, { error: err.message })
        return
      }
      if (!authed.userWorkspace) {
        sendJSON(res, 500, { error: 'Auth succeeded without user workspace' })
        return
      }
      if (
        url !== '/workspace/reset' &&
        isWorkspaceResetting(authed.userWorkspace)
      ) {
        sendJSON(res, 423, { error: 'Workspace reset in progress' })
        return
      }
      return runWithRequestScope(
        {
          agentHome: authed.userWorkspace,
          cwd: authed.userWorkspace,
        },
        () => handleProtected(),
      )
    }

    return handleProtected()

    async function handleProtected() {
      if (method === 'GET' && url?.startsWith('/slash-commands')) {
        const query = new URLSearchParams(url.split('?')[1] ?? '')
        const workspace = query.get('workspace')
        const cwd =
          authed.userWorkspace ??
          (workspace && fs.existsSync(workspace)
            ? path.resolve(workspace)
            : getDefaultWorkspace())
        try {
          const entries = await listSlashCommands(cwd)
          sendJSON(res, 200, { workspace: cwd, entries })
        } catch (e) {
          sendJSON(res, 500, { error: (e as Error).message })
        }
        return
      }

      if (method === 'GET' && url?.startsWith('/plugins')) {
        const query = new URLSearchParams(url.split('?')[1] ?? '')
        const workspace = query.get('workspace')
        const cwd =
          authed.userWorkspace ??
          (workspace && fs.existsSync(workspace)
            ? path.resolve(workspace)
            : getDefaultWorkspace())
        try {
          const overview = await loadPluginsOverview(cwd)
          sendJSON(res, 200, { workspace: cwd, ...overview })
        } catch (e) {
          sendJSON(res, 500, { error: (e as Error).message })
        }
        return
      }

      if (
        method === 'GET' &&
        (url === '/browser/lock' || url?.startsWith('/browser/lock?'))
      ) {
        const query = new URLSearchParams((url ?? '').split('?')[1] ?? '')
        const sessionId = query.get('session_id') ?? undefined
        sendJSON(res, 200, {
          live: isBrowserLive(sessionId),
          userHasControl: sessionId
            ? getUserHasControl(sessionId)
            : anyUserHasControl(),
        })
        return
      }

      if (
        method === 'POST' &&
        (url === '/browser/lock' || url?.startsWith('/browser/lock?'))
      ) {
        const body = await readBody(req)
        if (typeof body.userHasControl !== 'boolean') {
          sendJSON(res, 400, { error: 'userHasControl must be a boolean' })
          return
        }
        const sessionId =
          (typeof body.session_id === 'string' && body.session_id) ||
          new URLSearchParams((url ?? '').split('?')[1] ?? '').get(
            'session_id',
          ) ||
          undefined
        if (sessionId) setUserHasControl(body.userHasControl, sessionId)
        else setUserHasControlEverywhere(body.userHasControl)
        sendJSON(res, 200, {
          live: isBrowserLive(sessionId),
          userHasControl: sessionId
            ? getUserHasControl(sessionId)
            : anyUserHasControl(),
        })
        return
      }

      if (await handleWorkspaceReset(req, res)) return
      if (await handleScheduledTasks(req, res)) return
      if (await workspaceRouter(req, res)) return
      if (await marketplaceRouter(req, res)) return
      if (await skillsApi(req, res)) return
      if (await executionRouter(req, res)) return

      if (method === 'POST' && url === '/sessions') {
        let workspace: string | undefined
        try {
          const body = await readBody(req)
          if (typeof body.workspace === 'string' && body.workspace.length > 0) {
            workspace = body.workspace
          }
        } catch {
          // empty body ok
        }
        const session = createSession(authed.user?.email)
        const cwd =
          authed.userWorkspace ??
          (workspace && fs.existsSync(workspace)
            ? path.resolve(workspace)
            : getDefaultWorkspace())
        try {
          const picker = await loadResolvedAgentPicker(cwd)
          applyPickerDefaultsToSession(session, picker)
        } catch (e) {
          console.warn(
            `[server] apply picker defaults failed: ${(e as Error).message}`,
          )
        }
        console.log(`[server] new session: ${session.id}`)
        sendJSON(res, 200, {
          session_id: session.id,
          mode: session.permissionMode.mode,
          agentType: session.agentType ?? null,
        })
        return
      }
      if (method === 'GET' && url === '/sessions') {
        // SSO: regular users see only their sessions; super see all.
        const owner =
          isAuthEnabled() && !isSuperUser(authed.user)
            ? authed.user?.email
            : undefined
        sendJSON(res, 200, {
          sessions: listSessions(owner),
          view_all: isSuperUser(authed.user),
        })
        return
      }
      if (method === 'DELETE' && url?.startsWith('/sessions/')) {
        const id = url.split('/sessions/')[1]
        const session = getSession(id)
        // 404 (not 403) when the caller doesn't own it — don't leak existence.
        // Super may view any session but may only delete their own.
        if (
          session &&
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }
        if (
          session &&
          isAuthEnabled() &&
          isSuperUser(authed.user) &&
          session.ownerEmail &&
          session.ownerEmail !== authed.user?.email
        ) {
          sendJSON(res, 403, { error: "Cannot delete another user's session" })
          return
        }
        deleteSession(id)
        sendJSON(res, 200, { deleted: id })
        return
      }
      if (handleSessionLive(req, res)) return
      if (method === 'GET' && url?.match(/^\/sessions\/[^/]+\/messages$/)) {
        const id = url.split('/sessions/')[1].split('/messages')[0]
        const session = getSession(id)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }
        sendJSON(res, 200, { messages: sessionJsonlToUIMessages(id) })
        return
      }

      // Browser screenshots written by the browser_* tools. The filename pattern
      // is the whole defence against traversal — it admits nothing but the
      // `<toolCallId>.<ext>` names attachScreenshot writes.
      const shotMatch = url?.match(/^\/sessions\/([^/]+)\/browser\/([^/]+)$/)
      if (method === 'GET' && shotMatch) {
        const id = decodeURIComponent(shotMatch[1]!)
        const file = decodeURIComponent(shotMatch[2]!)
        const session = getSession(id)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role) ||
          !/^[A-Za-z0-9_-]+\.(png|jpeg)$/.test(file)
        ) {
          sendJSON(res, 404, { error: 'Not found' })
          return
        }
        const { getBrowserLogsSessionDir, requireSessionLocation } =
          await import('../core/session-paths.js')
        const fsp = await import('fs/promises')
        try {
          const location = requireSessionLocation(id)
          const buf = await fsp.readFile(
            path.join(getBrowserLogsSessionDir(id, location.agentHome), file),
          )
          res.writeHead(200, {
            'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(buf)
        } catch {
          sendJSON(res, 404, { error: 'Not found' })
        }
        return
      }

      // User chat attachments (claim-check; see utils/chat-uploads.ts).
      const uploadGetMatch = url?.match(
        /^\/sessions\/([^/]+)\/uploads\/([^/?]+)(?:\?.*)?$/,
      )
      if (method === 'GET' && uploadGetMatch) {
        const id = decodeURIComponent(uploadGetMatch[1]!)
        const file = decodeURIComponent(uploadGetMatch[2]!)
        const {
          CHAT_UPLOAD_ANY_FILE_RE,
          CHAT_UPLOAD_FILE_RE,
          mimeFromUploadFileName,
          resolveChatUploadFileAbs,
        } = await import('../utils/chat-uploads.js')
        const session = getSession(id)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role) ||
          !CHAT_UPLOAD_ANY_FILE_RE.test(file)
        ) {
          sendJSON(res, 404, { error: 'Not found' })
          return
        }
        const uploadPath = resolveChatUploadFileAbs(id, file)
        if (!uploadPath) {
          sendJSON(res, 404, { error: 'Not found' })
          return
        }
        try {
          const stat = await fs.promises.stat(uploadPath)
          if (!stat.isFile()) throw new Error('Not a file')
          // Only images render inline. Anything else (html, svg, pdf) is a
          // stored-XSS vector when served from the app origin, so force a
          // download with an opaque type.
          const isImage = CHAT_UPLOAD_FILE_RE.test(file)
          const headers: Record<string, string> = {
            'content-type': isImage
              ? mimeFromUploadFileName(file)
              : 'application/octet-stream',
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            'content-length': String(stat.size),
          }
          if (!isImage) {
            headers['content-disposition'] =
              `attachment; filename="${file.replace(/"/g, '')}"`
          }
          res.writeHead(200, headers)
          const stream = fs.createReadStream(uploadPath)
          stream.on('error', () => res.destroy())
          res.on('close', () => stream.destroy())
          stream.pipe(res)
        } catch {
          sendJSON(res, 404, { error: 'Not found' })
        }
        return
      }

      const uploadPostMatch = url?.match(/^\/sessions\/([^/]+)\/uploads$/)
      if (method === 'POST' && uploadPostMatch) {
        const id = decodeURIComponent(uploadPostMatch[1]!)
        const session = getSession(id)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }
        const { handleSessionChatUploads } =
          await import('./routes/chat-uploads.js')
        await handleSessionChatUploads(req, res, id)
        return
      }

      // Create session (optional) + upload images in one shot for first message.
      // Client may pass ?session_id= — compare pathname only (same as /chat).
      if (method === 'POST' && url?.split('?')[0] === '/chat/uploads') {
        let sessionIdBody: string | undefined
        // Content-Type is multipart — session_id may arrive as a form field after
        // multer parses. Prefer query ?session_id= for early binding.
        try {
          const u = new URL(req.url || '', 'http://localhost')
          const q = u.searchParams.get('session_id')
          if (q) sessionIdBody = q
        } catch {
          /* ignore */
        }
        let session =
          sessionIdBody && getSession(sessionIdBody)
            ? getSession(sessionIdBody)
            : null
        if (
          session &&
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }
        if (!session) {
          session = createSession(authed.user?.email)
          console.log(`[server] new session (chat upload): ${session.id}`)
        }
        const { handleSessionChatUploads } =
          await import('./routes/chat-uploads.js')
        await handleSessionChatUploads(req, res, session.id)
        return
      }

      // Background shell tasks
      const tasksListMatch = url?.match(/^\/sessions\/([^/]+)\/tasks$/)
      if (method === 'GET' && tasksListMatch) {
        const id = tasksListMatch[1]!
        const session = getSession(id)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }
        const { listSessionTasks } = await import('../utils/task/framework.js')
        const tasks = listSessionTasks(id).map(t => ({
          id: t.id,
          type: t.type,
          status: t.status,
          description: t.description,
          startTime: t.startTime,
          endTime: t.endTime,
          outputFile: t.outputFile,
          command:
            'command' in t ? (t as { command?: string }).command : undefined,
        }))
        sendJSON(res, 200, { tasks })
        return
      }
      const taskStopMatch = url?.match(
        /^\/sessions\/([^/]+)\/tasks\/([^/]+)\/stop$/,
      )
      if (method === 'POST' && taskStopMatch) {
        const id = taskStopMatch[1]!
        const taskId = taskStopMatch[2]!
        const session = getSession(id)
        if (
          !session ||
          !canAccessSession(session, authed.user?.email, authed.user?.role)
        ) {
          sendJSON(res, 404, { error: 'Session not found' })
          return
        }
        try {
          const { resolveExecutionBackend } =
            await import('../execution/resolve-backend.js')
          const { stopTask } = await import('../tasks/stopTask.js')
          const execution = await resolveExecutionBackend(session)
          const result = await stopTask(id, taskId, execution)
          sendJSON(res, 200, result)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          sendJSON(res, 400, { error: msg })
        }
        return
      }

      if (method === 'GET' && url?.startsWith('/settings')) {
        const cwd = resolveSettingsRequestCwd(authed, url)
        const effective = await resolveEffectiveSettings(cwd)
        const ssoMode = isAuthEnabled() && !!authed.userWorkspace
        // Hide absolute managed (policy) paths from SSO tenants — same idea as
        // not exposing enterprise policy file locations in the product UI.
        const sources = ssoMode
          ? effective.sources.map(s =>
              s.scope === 'managed' ? { ...s, path: '[managed]' } : s,
            )
          : effective.sources
        sendJSON(res, 200, {
          ...getSafeSettings(effective),
          cwd,
          sources,
          validationErrors: effective.validationErrors,
          userDir: effective.userDir,
          projectDir: effective.projectDir,
          managedDir: ssoMode ? undefined : effective.managedDir,
          settingsPath: effective.projectPath,
          mcpServers: effective.config.mcpServers,
          effectiveMcpServers: effective.effectiveMcpServers,
          mcpStatus: await getMCPStatusForCwd(
            cwd,
            effective.effectiveMcpServers,
          ),
        })
        return
      }
      if (method === 'PATCH' && url === '/settings/models') {
        try {
          const body = await readBody(req)
          const cwd = resolveSettingsRequestCwd(authed, url)
          const scope = parseWritableScope(body.scope, {
            ssoMode: isAuthEnabled() && !!authed.userWorkspace,
          })
          const modelsPatch = { ...(body as Record<string, unknown>) }
          delete modelsPatch.scope
          const resolved = patchSettings(cwd, scope, {
            models: modelsPatch as unknown as AppConfig['models'],
          })
          const safe = getSafeSettings(resolved)
          sendJSON(res, 200, {
            models: safe.models,
            scope,
            sources: resolved.sources,
          })
        } catch (e) {
          sendJSON(res, 400, { error: (e as Error).message })
        }
        return
      }
      if (method === 'PATCH' && url === '/settings/mcp') {
        try {
          const body = await readBody(req)
          const action = body.action as string
          const cwd = resolveSettingsRequestCwd(authed, url)
          const scope = parseWritableScope(body.scope, {
            ssoMode: isAuthEnabled() && !!authed.userWorkspace,
          })
          let resolved = await resolveEffectiveSettings(cwd)

          if (action === 'add') {
            const name = body.name as string
            const config = body.config as MCPServerConfig
            if (!name || !config) {
              sendJSON(res, 400, { error: "Missing 'name' and/or 'config'" })
              return
            }
            setMCPServer(cwd, scope, name, config)
          } else if (action === 'remove') {
            const name = body.name as string
            if (!name) {
              sendJSON(res, 400, { error: "Missing 'name'" })
              return
            }
            setMCPServer(cwd, scope, name, null)
          } else {
            sendJSON(res, 400, { error: "action must be 'add' or 'remove'" })
            return
          }

          invalidateMCPManagersForCwd(cwd)
          resolved = await resolveEffectiveSettings(cwd)
          sendJSON(res, 200, {
            mcpServers: resolved.config.mcpServers,
            effectiveMcpServers: resolved.effectiveMcpServers,
            mcpStatus: await getMCPStatusForCwd(
              cwd,
              resolved.effectiveMcpServers,
            ),
            scope,
            sources: resolved.sources,
          })
        } catch (e) {
          sendJSON(res, 400, { error: (e as Error).message })
        }
        return
      }

      if (method === 'GET' && url?.startsWith('/mcp')) {
        const cwd = resolveSettingsRequestCwd(authed, url)
        const effective = await resolveEffectiveSettings(cwd)
        sendJSON(res, 200, {
          servers: await getMCPStatusForCwd(cwd, effective.effectiveMcpServers),
        })
        return
      }

      if (method === 'GET' && url?.startsWith('/lsp')) {
        const cwd = resolveSettingsRequestCwd(authed, url)
        const effective = await resolveEffectiveSettings(cwd)
        let servers = getLspStatusForCwd(cwd, effective.config.lspServers)
        // Live LSP state lives inside the Worker (not the HTTP process). Prefer
        // a snapshot from an open runtime for this cwd when available.
        try {
          const found = getExecutionPlane().runtimes.findByCwd(cwd)
          if (found) {
            const backend = new WorkerExecutionBackend(
              found.handle.environmentId,
              found.runtime,
              found.handle.environmentId === 'local' ? 'local' : 'posix',
              found.handle.cwd,
              effective.config.lspServers,
            )
            try {
              const live = await backend.lspListStatus()
              if (live.length > 0) {
                servers = live.map(s => ({
                  name: s.name,
                  state: s.state as (typeof servers)[number]['state'],
                  command: s.command,
                  args: s.args,
                  extensions: s.extensions,
                  languages: s.languages,
                  error: s.error,
                }))
              }
            } finally {
              backend.dispose()
            }
          }
        } catch {
          // Keep control-plane peek / configured stopped rows.
        }
        sendJSON(res, 200, {
          workspace: cwd,
          servers,
          runningCount: servers.filter(s => s.state === 'running').length,
        })
        return
      }

      if (method === 'POST' && url === '/plan/approve') {
        try {
          const body = await readBody(req)
          const requestId = body.request_id as string
          const approved = body.approved as boolean
          const editedPlan = body.edited_plan as string | undefined
          const targetMode = body.target_mode as string | undefined
          const reason = body.reason as string | undefined

          if (!requestId || typeof approved !== 'boolean') {
            sendJSON(res, 400, { error: "Missing 'request_id' or 'approved'" })
            return
          }

          const ok = answerPlanApproval(requestId, {
            approved,
            editedPlan,
            targetMode:
              targetMode === 'ask' || targetMode === 'agent'
                ? targetMode
                : 'agent',
            reason,
          })
          sendJSON(
            res,
            ok ? 200 : 404,
            ok
              ? { ok: true }
              : { error: 'No pending plan approval with that id' },
          )
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url === '/session/mode') {
        try {
          const body = await readBody(req)
          const sessionId = body.session_id as string
          const mode = body.mode as string
          const workspace = body.workspace as string | undefined

          if (!sessionId || !isValidExternalMode(mode)) {
            sendJSON(res, 400, {
              error: "Missing 'session_id' or valid 'mode'",
            })
            return
          }

          const session = getSession(sessionId)
          if (
            !session ||
            !canAccessSession(session, authed.user?.email, authed.user?.role)
          ) {
            sendJSON(res, 404, { error: 'Session not found' })
            return
          }

          const cwd =
            authed.userWorkspace ??
            (workspace && fs.existsSync(workspace)
              ? path.resolve(workspace)
              : getDefaultWorkspace())

          const from = session.permissionMode.mode
          if (from !== mode) {
            const picker = await loadResolvedAgentPicker(cwd)
            const modeErr = pickerModeError(picker, mode)
            if (modeErr) {
              sendJSON(res, 400, { error: modeErr })
              return
            }
            handlePlanModeTransition(from, mode, session)
            session.permissionMode = transitionPermissionMode(
              from,
              mode,
              session.permissionMode,
            )
            // Ask/Plan clear main-thread specialist (P0 UX).
            if (mode === 'ask' || mode === 'plan') {
              session.agentType = null
            }
            appendModeChange(sessionId, session)
          }

          sendJSON(res, 200, {
            mode: session.permissionMode.mode,
            agentType: session.agentType ?? null,
            planFilePath: getPlanFilePath(session, cwd),
          })
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url === '/session/agent') {
        try {
          const body = await readBody(req)
          const sessionId = body.session_id as string
          const agentTypeRaw = body.agentType
          const workspace = body.workspace as string | undefined

          if (!sessionId) {
            sendJSON(res, 400, { error: "Missing 'session_id'" })
            return
          }
          if (
            agentTypeRaw !== null &&
            agentTypeRaw !== undefined &&
            typeof agentTypeRaw !== 'string'
          ) {
            sendJSON(res, 400, {
              error: "'agentType' must be a string or null",
            })
            return
          }

          const session = getSession(sessionId)
          if (
            !session ||
            !canAccessSession(session, authed.user?.email, authed.user?.role)
          ) {
            sendJSON(res, 404, { error: 'Session not found' })
            return
          }

          const cwd =
            authed.userWorkspace ??
            (workspace && fs.existsSync(workspace)
              ? path.resolve(workspace)
              : getDefaultWorkspace())

          const nextType =
            agentTypeRaw === undefined ||
            agentTypeRaw === null ||
            agentTypeRaw === ''
              ? null
              : (agentTypeRaw as string)

          if (nextType !== null) {
            const { agents } = await loadWorkspaceContributions(cwd)
            const profile = findPrimaryAgent(agents.activeAgents, nextType)
            if (!profile) {
              sendJSON(res, 400, {
                error: `Unknown or non-primary agentType '${nextType}'`,
              })
              return
            }
          }

          const picker = await loadResolvedAgentPicker(cwd)
          const typeErr = pickerAgentTypeError(picker, nextType)
          if (typeErr) {
            sendJSON(res, 400, { error: typeErr })
            return
          }

          const prev = session.agentType ?? null
          const prevMode = session.permissionMode.mode
          session.agentType = nextType

          // Selecting a specialist forces Agent permission mode on the main thread.
          if (nextType !== null && session.permissionMode.mode !== 'agent') {
            const from = session.permissionMode.mode
            handlePlanModeTransition(from, 'agent', session)
            session.permissionMode = transitionPermissionMode(
              from,
              'agent',
              session.permissionMode,
            )
          }

          if (prev !== nextType || prevMode !== session.permissionMode.mode) {
            appendAgentChange(sessionId, session)
          }

          sendJSON(res, 200, {
            agentType: session.agentType ?? null,
            mode: session.permissionMode.mode,
            planFilePath: getPlanFilePath(session, cwd),
          })
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url === '/ask_user_question/answer') {
        try {
          const body = await readBody(req)
          const id = body.id as string
          const answers = body.answers as Record<string, string> | undefined
          const annotations = body.annotations as
            Record<string, { preview?: string; notes?: string }> | undefined
          if (!id || !answers || typeof answers !== 'object') {
            sendJSON(res, 400, { error: "Missing 'id' or 'answers' object" })
            return
          }
          const ok = answerQuestion(id, { answers, annotations })
          sendJSON(
            res,
            ok ? 200 : 404,
            ok ? { ok: true } : { error: 'No pending question with that id' },
          )
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url === '/can_use_tool/answer') {
        try {
          const body = await readBody(req)
          const id = body.id as string
          const raw = body.decision as string | undefined
          const decision =
            raw === 'always' || raw === 'allow' || raw === 'reject' ? raw : null
          if (!id || !decision) {
            sendJSON(res, 400, { error: "Missing 'id' or 'decision'" })
            return
          }
          const ok = answerPermission(id, {
            behavior: decision === 'reject' ? 'deny' : decision,
          })
          sendJSON(
            res,
            ok ? 200 : 404,
            ok ? { ok: true } : { error: 'No pending permission with that id' },
          )
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url === '/tool/abort') {
        try {
          const body = await readBody(req)
          const sessionId = body.session_id as string
          const toolUseId = (body.tool_use_id ?? body.toolCallId) as string
          if (!sessionId || !toolUseId) {
            sendJSON(res, 400, {
              error: "Missing 'session_id' or 'tool_use_id'",
            })
            return
          }
          const session = getSession(sessionId)
          const requesterEmail = (req as AuthedRequest).user?.email
          if (
            !session ||
            !canAccessSession(
              session,
              requesterEmail,
              (req as AuthedRequest).user?.role,
            )
          ) {
            sendJSON(res, 404, { error: `Session not found: ${sessionId}` })
            return
          }
          const ok = abortTool(sessionId, toolUseId)
          sendJSON(
            res,
            ok ? 200 : 404,
            ok ? { ok: true } : { error: 'No running tool with that id' },
          )
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url === '/chat/cancel') {
        try {
          const body = await readBody(req)
          const sessionId = body.session_id as string
          if (!sessionId) {
            sendJSON(res, 400, { error: "Missing 'session_id'" })
            return
          }
          const session = getSession(sessionId)
          const requesterEmail = (req as AuthedRequest).user?.email
          if (
            !session ||
            !canAccessSession(
              session,
              requesterEmail,
              (req as AuthedRequest).user?.role,
            )
          ) {
            sendJSON(res, 404, { error: `Session not found: ${sessionId}` })
            return
          }
          const ok = abortTurn(sessionId, 'user-cancel')
          sendJSON(res, 200, { ok, session_id: sessionId })
        } catch {
          sendJSON(res, 400, { error: 'Invalid JSON' })
        }
        return
      }

      if (method === 'POST' && url?.split('?')[0] === '/chat') {
        await handleChat(req, res, lazyRunAgent)
        return
      }

      if (staticDir && serveStaticFile(req, res, staticDir)) return

      sendJSON(res, 404, { error: 'Not found' })
    } // handleProtected
  }
}
