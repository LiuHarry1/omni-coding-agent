/**
 * Snapshot memory is keyed by tab id. User-control lock is keyed by chat
 * session so two conversations cannot steal each other's Take Control state.
 */

import { SNAPSHOT_TTL_MS } from './limits.js'
import { parseRefMeta, type RefMeta } from './snapshot-index.js'
import {
  abortBlockedBrowserTools,
  abortBlockedBrowserToolsEverywhere,
} from './active-browser-tools.js'

export const DEFAULT_BROWSER_SESSION_KEY = 'default'

const snapshotDegraded = new Map<string, boolean>()
const poisonedTabs = new Set<string>()
const lastSnapshot = new Map<string, string>()
const lastSnapshotAt = new Map<string, number>()
const refMetaByTarget = new Map<string, Map<string, RefMeta>>()
const unsettledRequests = new Map<string, string[]>()
const controlBySession = new Map<string, boolean>()
let globalControl = false
const lockListeners = new Set<(userHasControl: boolean) => void>()

function lockKey(sessionId?: string): string {
  return sessionId && sessionId.length > 0
    ? sessionId
    : DEFAULT_BROWSER_SESSION_KEY
}

function notifyLockListeners(): void {
  const value = anyUserHasControl()
  for (const fn of lockListeners) fn(value)
}

export function setSnapshotDegraded(targetId: string, degraded: boolean): void {
  if (!targetId) return
  if (degraded) snapshotDegraded.set(targetId, true)
  else snapshotDegraded.delete(targetId)
}

export function isSnapshotDegraded(targetId: string): boolean {
  return snapshotDegraded.get(targetId) === true
}

export function rememberSnapshot(targetId: string, yaml: string): void {
  if (!targetId || !yaml) return
  lastSnapshot.set(targetId, yaml)
  lastSnapshotAt.set(targetId, Date.now())
  const map = new Map<string, RefMeta>()
  for (const meta of parseRefMeta(yaml)) {
    map.set(meta.ref, meta)
  }
  refMetaByTarget.set(targetId, map)
}

export function getLastSnapshot(targetId: string): string | undefined {
  return lastSnapshot.get(targetId)
}

export function isSnapshotStale(targetId: string): boolean {
  const at = lastSnapshotAt.get(targetId)
  if (!at) return true
  return Date.now() - at > SNAPSHOT_TTL_MS
}

export function getRefMeta(targetId: string, ref: string): RefMeta | undefined {
  return refMetaByTarget.get(targetId)?.get(ref)
}

/** Snapshot refs for labeled screenshots. */
export function listRefMeta(
  targetId: string,
): Record<string, { role: string; name?: string }> {
  const map = refMetaByTarget.get(targetId)
  const out: Record<string, { role: string; name?: string }> = {}
  if (!map) return out
  for (const [ref, meta] of map) {
    out[ref] = { role: meta.role, ...(meta.name ? { name: meta.name } : {}) }
  }
  return out
}

export function setTabPoisoned(targetId: string): void {
  if (targetId) poisonedTabs.add(targetId)
}

export function isTabPoisoned(targetId: string): boolean {
  return poisonedTabs.has(targetId)
}

export function clearTabMemory(targetId: string): void {
  snapshotDegraded.delete(targetId)
  poisonedTabs.delete(targetId)
  lastSnapshot.delete(targetId)
  lastSnapshotAt.delete(targetId)
  refMetaByTarget.delete(targetId)
  unsettledRequests.delete(targetId)
}

/** URLs the last action's drain gave up on; empty clears the record. */
export function setUnsettledRequests(targetId: string, urls: string[]): void {
  if (!targetId) return
  if (urls.length > 0) unsettledRequests.set(targetId, urls)
  else unsettledRequests.delete(targetId)
}

/** Read once by the post-action result, so the hint never repeats. */
export function takeUnsettledRequests(targetId: string): string[] {
  const urls = unsettledRequests.get(targetId) ?? []
  unsettledRequests.delete(targetId)
  return urls
}

export function setUserHasControl(value: boolean, sessionId?: string): void {
  const key = lockKey(sessionId)
  const prev = controlBySession.get(key) === true
  if (prev === value) return
  if (value) controlBySession.set(key, true)
  else controlBySession.delete(key)
  if (value) abortBlockedBrowserTools(key)
  notifyLockListeners()
}

export function setUserHasControlEverywhere(value: boolean): void {
  const was = anyUserHasControl()
  globalControl = value
  if (!value) controlBySession.clear()
  if (value && !was) abortBlockedBrowserToolsEverywhere()
  notifyLockListeners()
}

export function getUserHasControl(sessionId?: string): boolean {
  if (globalControl) return true
  return controlBySession.get(lockKey(sessionId)) === true
}

export function anyUserHasControl(): boolean {
  if (globalControl) return true
  for (const value of controlBySession.values()) {
    if (value) return true
  }
  return false
}

export function onUserControlChange(
  fn: (userHasControl: boolean) => void,
): () => void {
  lockListeners.add(fn)
  return () => lockListeners.delete(fn)
}

export function resetSessionFlags(sessionId?: string): void {
  if (sessionId) {
    controlBySession.delete(lockKey(sessionId))
    notifyLockListeners()
    return
  }
  snapshotDegraded.clear()
  lastSnapshot.clear()
  lastSnapshotAt.clear()
  refMetaByTarget.clear()
  controlBySession.clear()
  globalControl = false
  for (const fn of lockListeners) fn(false)
}
