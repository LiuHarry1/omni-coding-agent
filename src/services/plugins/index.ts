/**
 * Plugin system entry point.
 *
 * Two complementary mechanisms (see parity notes in `loader.ts`
 * and `runtime.ts`):
 *
 *   1. Declarative plugins — `loadPlugins(cwd)` discovers `.ai-agent/plugins/*`
 *      and returns agents/commands/skills/MCP contributions. Threaded into the
 *      per-request pipeline (`prepareChatTurn`, `slashRegistry`, `mcp-lifecycle`).
 *
 *   2. Code plugins — `initCodePlugins()` wires the `PluginManager` at boot so
 *      compiled `Plugin` objects can register tools/middleware/events.
 */

import { PluginManager } from './manager.js'
import type { IToolRegistry } from '../../core/types.js'
import { CODE_PLUGINS } from './code-plugins.js'
import { createCodePluginContext } from './runtime.js'

export { loadPlugins } from './loader.js'
export { applyPluginHooks, hasPluginHooks } from './runtime.js'
export { pluginErrorMessage, pluginErrorSource } from './types.js'
export type {
  LoadedPlugin,
  PluginContributions,
  PluginError,
  PluginManifest,
} from './types.js'

let manager: PluginManager | null = null

/**
 * Instantiate the PluginManager and initialize all code plugins. Idempotent —
 * safe to call once from server boot. Tool registrations land on `registry`
 * immediately; middleware/event hooks are recorded for per-request replay.
 */
export async function initCodePlugins(registry: IToolRegistry): Promise<void> {
  if (manager) return
  manager = new PluginManager(createCodePluginContext(registry))
  for (const plugin of CODE_PLUGINS) {
    manager.register(plugin)
  }
  await manager.initAll()
  if (CODE_PLUGINS.length > 0) {
    console.log(`[plugins] initialized ${CODE_PLUGINS.length} code plugin(s)`)
  }
}
