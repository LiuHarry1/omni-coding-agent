/**
 * System-prompt blurb when File tools deny paths outside the workspace.
 * Combines AUTH-derived mode with settings `permissions.defaultMode`.
 */
import { resolveSettings } from '../settings/manager.js'
import {
  resolveFilesystemPermissionMode,
  workspaceBoundaryPromptSection as renderWorkspaceBoundary,
} from './filesystem.js'

/** Empty unless mode is `dontAsk` (SSO AUTH or settings). */
export function workspaceBoundaryPromptSection(cwd: string): string {
  if (resolveFilesystemPermissionMode() === 'dontAsk') {
    return renderWorkspaceBoundary(cwd, 'dontAsk')
  }
  try {
    if (resolveSettings(cwd).config.permissions?.defaultMode === 'dontAsk') {
      return renderWorkspaceBoundary(cwd, 'dontAsk')
    }
  } catch {
    // settings may be unavailable during early boot
  }
  return ''
}
