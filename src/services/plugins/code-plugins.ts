/**
 * Registry of *code* plugins compiled into the build.
 *
 * Unlike declarative plugins (directories under `.ai-agent/plugins/`), a code
 * plugin is a JS/TS object implementing the `Plugin` interface from
 * `core/types.ts`. Its `init(ctx)` runs once at boot with access to:
 *
 *   - `ctx.tools`      — register new `ToolDefinition`s on the global registry
 *   - `ctx.middleware` — add beforeTool/afterTool/onError hooks
 *   - `ctx.events`     — subscribe to the event bus (e.g. `tool_timing`)
 *
 * Add plugins to `CODE_PLUGINS`. Example:
 *
 *   import type { Plugin } from "../../core/types.js";
 *
 *   const auditPlugin: Plugin = {
 *     name: "audit-log",
 *     init(ctx) {
 *       ctx.middleware.use("afterTool", (c) => {
 *         console.log(`[audit] ${c.name} took ${c.duration}ms`);
 *       });
 *     },
 *   };
 *
 *   export const CODE_PLUGINS: Plugin[] = [auditPlugin];
 */

import type { Plugin } from '../../core/types.js'

export const CODE_PLUGINS: Plugin[] = []
