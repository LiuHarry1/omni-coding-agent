/**
 * Per-call phase timing for browser_click, off unless AGENT_CLICK_TIMING=1.
 * Phases are only recorded inside a `traceClick` scope, so helpers shared with
 * other actions stay silent there. Each click appends one JSON line to
 * `{agentHome}/.ai-agent/browser-logs/click-timing.log`, rotated to `.1` at
 * MAX_LOG_BYTES.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { getBrowserLogsDir } from '../core/session-paths.js'

interface Phase {
  name: string
  /** Start offset from the beginning of the click, ms. */
  at: number
  ms: number
}

interface ClickTrace {
  startedAt: number
  phases: Phase[]
  notes: Record<string, unknown>
}

const storage = new AsyncLocalStorage<ClickTrace>()

const MAX_LOG_BYTES = 5 * 1024 * 1024

function isEnabled(): boolean {
  return process.env.AGENT_CLICK_TIMING === '1'
}

export function clickTimingLogPath(): string {
  return path.join(getBrowserLogsDir(), 'click-timing.log')
}

function flush(trace: ClickTrace, error?: string): void {
  const totalMs = Math.round(performance.now() - trace.startedAt)
  const phases = [...trace.phases].sort((a, b) => a.at - b.at)
  const line = {
    ts: new Date().toISOString(),
    totalMs,
    ...trace.notes,
    ...(error ? { error } : {}),
    phases,
  }
  const summary = phases.map(p => `${p.name}=${p.ms}`).join(' ')
  console.log(`[click-timing] total=${totalMs}ms ${summary}`)
  try {
    const file = clickTimingLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
  } catch {
    /* timing must never break the click */
  }
}

export async function traceClick<T>(
  notes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isEnabled()) return fn()
  const trace: ClickTrace = {
    startedAt: performance.now(),
    phases: [],
    notes: { ...notes },
  }
  let error: string | undefined
  try {
    return await storage.run(trace, fn)
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : String(err)
    throw err
  } finally {
    flush(trace, error)
  }
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const trace = storage.getStore()
  if (!trace) return fn()
  const start = performance.now()
  try {
    return await fn()
  } finally {
    trace.phases.push({
      name,
      at: Math.round(start - trace.startedAt),
      ms: Math.round(performance.now() - start),
    })
  }
}

/** Record a phase that started at `start` (a `performance.now()` value). */
export function recordPhase(name: string, start: number): void {
  const trace = storage.getStore()
  if (!trace) return
  trace.phases.push({
    name,
    at: Math.round(start - trace.startedAt),
    ms: Math.round(performance.now() - start),
  })
}

export function noteClick(key: string, value: unknown): void {
  const trace = storage.getStore()
  if (trace) trace.notes[key] = value
}
