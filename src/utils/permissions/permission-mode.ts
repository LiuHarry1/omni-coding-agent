/**
 * Session-level permission modes. Three external modes map to Agent / Ask /
 * Plan UX.
 */

export type ExternalMode = 'agent' | 'ask' | 'plan'

export interface PermissionModeContext {
  mode: ExternalMode
  /** Stashed on plan entry; restored on ExitPlanMode approval. */
  preMode?: ExternalMode
  planSlug?: string
}

export function createDefaultPermissionMode(): PermissionModeContext {
  return { mode: 'agent' }
}

export function prepareContextForPlanMode(
  ctx: PermissionModeContext,
): PermissionModeContext {
  if (ctx.mode === 'plan') return ctx
  return { ...ctx, preMode: ctx.mode, mode: 'plan' }
}

export function handlePlanModeTransition(
  from: ExternalMode,
  to: ExternalMode,
  session: {
    permissionMode: PermissionModeContext
    hasExitedPlanMode?: boolean
    needsPlanModeExitAttachment?: boolean
  },
): void {
  if (to === 'plan' && from !== 'plan') {
    session.permissionMode = prepareContextForPlanMode(session.permissionMode)
    session.needsPlanModeExitAttachment = false
  }
  if (from === 'plan' && to !== 'plan') {
    session.hasExitedPlanMode = true
    session.needsPlanModeExitAttachment = true
  }
}

export function transitionPermissionMode(
  from: ExternalMode,
  to: ExternalMode,
  ctx: PermissionModeContext,
): PermissionModeContext {
  if (from === to) return ctx

  if (to === 'plan') {
    return prepareContextForPlanMode(ctx)
  }

  if (from === 'plan') {
    // `to` is never "plan" here — `from === to` returned above.
    return { ...ctx, mode: to, preMode: undefined }
  }

  return { ...ctx, mode: to }
}

export const EXTERNAL_MODES: readonly ExternalMode[] = ['agent', 'ask', 'plan']

export function isValidExternalMode(value: unknown): value is ExternalMode {
  return (
    typeof value === 'string' &&
    (EXTERNAL_MODES as readonly string[]).includes(value)
  )
}

export function getNextExternalMode(current: ExternalMode): ExternalMode {
  const idx = EXTERNAL_MODES.indexOf(current)
  return EXTERNAL_MODES[(idx + 1) % EXTERNAL_MODES.length]!
}
