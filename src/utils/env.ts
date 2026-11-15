/**
 * How environment switches are read. Kept free of imports so any module can
 * use it.
 */

/** `1`, `true`, `yes` or `on`, in any case. */
export function isEnvTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/**
 * Sign-in is on (`AUTH_ENABLED=true`). Only `true` counts: the deploy scripts
 * and the web app decide by the same rule, and all three have to agree.
 */
export function isAuthEnabled(): boolean {
  return (process.env.AUTH_ENABLED ?? '').trim().toLowerCase() === 'true'
}
