/**
 * Runtime wire protocol (Control Plane ↔ Worker).
 * Transport-agnostic; SSH/stdio/WS are just carriers.
 *
 * Target architecture: Control Plane owns LLM/orchestration;
 * Worker owns all FS/shell/LSP. Messages below are the Worker RPC surface.
 */

import type { ShellKind } from '../core/shell/spawn-shell.js'

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

/** Filesystem / shell ops executed inside the Worker. */
export type WorkerFsOp =
  | { op: 'readText'; path: string }
  | { op: 'writeText'; path: string; content: string }
  | { op: 'mkdirp'; path: string }
  | { op: 'exists'; path: string }
  | { op: 'isDirectory'; path: string }
  | {
      op: 'exec'
      command: string
      cwd: string
      timeoutMs?: number
      /** Default `bash` (Git Bash on Windows). Use `powershell` for the PowerShell tool. */
      shell?: ShellKind
    }
  /**
   * Idempotently cancel a foreground exec by the requestId of its fs_op.
   * A missing target is acknowledged because the exec may have just settled.
   */
  | { op: 'exec_cancel'; targetRequestId: string }
  /** Background shell: spawn, write stdout/stderr to outputPath, return pid. */
  | {
      op: 'exec_bg_start'
      taskId: string
      command: string
      cwd: string
      outputPath: string
      shell?: ShellKind
    }
  | { op: 'exec_bg_poll'; taskId: string }
  | { op: 'exec_bg_kill'; taskId: string }
  /** Spawn `rg` with argv; exit 0/1 both succeed. */
  | {
      op: 'rg'
      args: string[]
      target: string
      timeoutMs?: number
    }

/** LSP ops executed inside the Worker (Language servers spawn co-located). */
export type WorkerLspOp =
  | { op: 'configure'; servers: Record<string, unknown> }
  | { op: 'hasServerForFile'; filePath: string }
  | { op: 'ensure'; filePath: string }
  | {
      op: 'request'
      filePath: string
      method: string
      params: unknown
    }
  | { op: 'openFile'; filePath: string; content: string }
  | { op: 'changeFile'; filePath: string; content: string }
  | { op: 'saveFile'; filePath: string }
  | { op: 'closeFile'; filePath: string }
  | { op: 'isFileOpen'; filePath: string }
  /** Snapshot of configured LSP servers + live state inside the Worker. */
  | { op: 'listStatus' }

export type RuntimeClientMessage =
  | {
      type: 'bind'
      workspace: { environmentId: string; cwd: string }
      lspServers?: Record<string, unknown>
    }
  | { type: 'fs_op'; requestId: string; op: WorkerFsOp }
  | { type: 'lsp_op'; requestId: string; op: WorkerLspOp }
  | {
      type: 'control_response'
      requestId: string
      decision: PermissionDecision
    }
  | { type: 'interrupt'; runId: string }
  | { type: 'ping'; id: string }
  | { type: 'shutdown' }

export type RuntimeServerMessage =
  | {
      type: 'ready'
      workspace: { environmentId: string; cwd: string }
      workerVersion?: string
    }
  | {
      type: 'fs_op_result'
      requestId: string
      ok: true
      data: unknown
    }
  | {
      type: 'fs_op_result'
      requestId: string
      ok: false
      error: string
    }
  | {
      type: 'lsp_op_result'
      requestId: string
      ok: true
      data: unknown
    }
  | {
      type: 'lsp_op_result'
      requestId: string
      ok: false
      error: string
    }
  | {
      type: 'control_request'
      requestId: string
      runId: string
      tool: string
      input: unknown
      description?: string
    }
  /** Fire-and-forget LSP notifications (e.g. publishDiagnostics → chat attachments). */
  | {
      type: 'lsp_event'
      event: 'diagnostics'
      serverName: string
      files: Array<{
        uri: string
        diagnostics: Array<{
          message: string
          severity: 'Error' | 'Warning' | 'Info' | 'Hint'
          range: {
            start: { line: number; character: number }
            end: { line: number; character: number }
          }
          source?: string
          code?: string
        }>
      }>
    }
  | { type: 'pong'; id: string }
  | { type: 'error'; message: string }
