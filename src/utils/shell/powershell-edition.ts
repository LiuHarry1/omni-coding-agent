import { spawnSync } from 'child_process'
import { isWindows } from '../platform.js'
import { resolvePowerShellExecutable } from './windows-paths.js'

/**
 * "desktop" = Windows PowerShell 5.1 (powershell.exe — bundled with Windows).
 * "core"    = PowerShell 7+ (pwsh — installed separately, has bash-like
 *             pipeline operators, ternary, null-coalescing).
 *
 * The two ship a meaningfully different language surface, and the model
 * cannot tell them apart from a generic "PowerShell" label — so we detect
 * the running edition once and embed it into the tool's description.
 */
export type PowerShellEdition = 'desktop' | 'core' | null

let cached: PowerShellEdition | undefined

/**
 * Synchronously detect the PowerShell edition. Blocks Node startup on
 * Windows for ~100-300 ms (one `powershell.exe` cold start). Acceptable
 * tradeoff: the description is sent at the first LLM turn, so async
 * detection would require either an awaited registration step or a
 * second pass — both adding more code than the savings justify.
 *
 * Returns `null` on non-Windows or if powershell isn't installed.
 */
export function detectPowerShellEdition(): PowerShellEdition {
  if (cached !== undefined) return cached
  if (!isWindows) {
    cached = null
    return cached
  }
  try {
    const result = spawnSync(
      resolvePowerShellExecutable(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSEdition.ToString()',
      ],
      { encoding: 'utf8', timeout: 5_000 },
    )
    const out = (result.stdout ?? '').trim().toLowerCase()
    if (out === 'desktop') {
      cached = 'desktop'
    } else if (out === 'core') {
      cached = 'core'
    } else {
      // PS spawned but emitted something we didn't expect (locale-translated
      // output? PS 2.0 without PSEdition?). Log so devs can see why the
      // edition-aware prompt section degraded to "unknown".
      cached = null
      const stderr = (result.stderr ?? '').trim()
      console.warn(
        `[powershell-edition] detection produced unexpected output; ` +
          `falling back to conservative 5.1 prompt. stdout=${JSON.stringify(out)} ` +
          `stderr=${JSON.stringify(stderr.slice(0, 200))} ` +
          `signal=${result.signal ?? 'none'} status=${result.status}`,
      )
    }
  } catch (err) {
    // powershell.exe missing from PATH, blocked by AppLocker, etc.
    cached = null
    console.warn(
      `[powershell-edition] failed to spawn powershell.exe; ` +
        `falling back to conservative 5.1 prompt. error=${(err as Error).message}`,
    )
  }
  return cached
}
