import type { SessionMode, SessionModeState } from '@agentclientprotocol/sdk'
import type { ExternalMode } from '../utils/permissions/permission-mode.js'
import type { Session } from '../core/types.js'

export const ACP_MODES: SessionMode[] = [
  {
    id: 'agent',
    name: 'Agent',
    description: 'Full tool access — read, write, and run commands.',
  },
  {
    id: 'ask',
    name: 'Ask',
    description: 'Read-only — no file edits or shell execution.',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Planning mode — design before implementation.',
  },
]

export function sessionModeState(session: Session): SessionModeState {
  const mode = session.permissionMode?.mode ?? 'agent'
  return {
    currentModeId: mode,
    availableModes: ACP_MODES,
  }
}

export function acpModeToExternal(modeId: string): ExternalMode | null {
  if (modeId === 'agent' || modeId === 'ask' || modeId === 'plan') {
    return modeId
  }
  return null
}
