import type {
  ToolDefinition,
  ToolContext,
  IToolRegistry,
  AnyTool,
} from './types.js'
import { computeToolEnabled, isDeferredTool } from './tool-enablement.js'

export interface SplitTools {
  /** Tools sent to the API on every request. */
  active: Record<string, AnyTool>
  /** Deferred tools — created but withheld until discovered via tool_search. */
  deferred: Record<string, AnyTool>
  /** Deferred tool metadata for tool_search index + system-reminder listing. */
  deferredDefs: Array<{ name: string; description: string; isMcp: boolean }>
}

export class ToolRegistry implements IToolRegistry {
  #tools = new Map<string, ToolDefinition>()

  /**
   * Snapshot the current definitions into an independent registry.
   * Per-turn Agents, Skills and dynamic tools may safely replace entries on
   * the fork without mutating the process-wide built-in/plugin registry.
   */
  fork(): ToolRegistry {
    const fork = new ToolRegistry()
    fork.#tools = new Map(this.#tools)
    return fork
  }

  register(def: ToolDefinition): void {
    this.#tools.set(def.name, def)
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.#tools.values()].map(d => ({
      name: d.name,
      description: d.description,
    }))
  }

  createAll(
    cwd: string,
    context: ToolContext,
    only?: string[],
  ): Record<string, AnyTool> {
    const tools: Record<string, AnyTool> = {}
    for (const [name, def] of this.#tools) {
      if (only && !only.includes(name)) continue
      if (!computeToolEnabled(name, def, context.toolEnablement)) continue

      const instance = def.create(cwd, context)
      if (
        context.middleware &&
        typeof (instance as any).execute === 'function'
      ) {
        const wrapped = context.middleware.wrap(name, (instance as any).execute)
        tools[name] = { ...instance, execute: wrapped } as AnyTool
      } else {
        tools[name] = instance
      }
    }
    return tools
  }

  /**
   * Like `createAll` but splits into active vs deferred pools.
   * MCP tools (passed separately) are auto-deferred unless `alwaysLoad`.
   */
  createSplit(
    cwd: string,
    context: ToolContext,
    mcpTools: Record<string, AnyTool>,
    discoveredTools?: ReadonlySet<string>,
  ): SplitTools {
    const active: Record<string, AnyTool> = {}
    const deferred: Record<string, AnyTool> = {}
    const deferredDefs: SplitTools['deferredDefs'] = []

    // Built-in tools
    for (const [name, def] of this.#tools) {
      if (!computeToolEnabled(name, def, context.toolEnablement)) continue

      const instance = this.#createInstance(name, def, cwd, context)

      if (isDeferredTool(def) && !discoveredTools?.has(name)) {
        deferred[name] = instance
        deferredDefs.push({ name, description: def.description, isMcp: false })
      } else {
        active[name] = instance
      }
    }

    // MCP tools — auto-deferred unless previously discovered
    for (const [name, instance] of Object.entries(mcpTools)) {
      if (discoveredTools?.has(name)) {
        active[name] = instance
      } else {
        deferred[name] = instance
        const desc = (instance as any).description ?? 'MCP tool'
        deferredDefs.push({ name, description: desc, isMcp: true })
      }
    }

    return { active, deferred, deferredDefs }
  }

  #createInstance(
    name: string,
    def: ToolDefinition,
    cwd: string,
    context: ToolContext,
  ): AnyTool {
    const instance = def.create(cwd, context)
    if (context.middleware && typeof (instance as any).execute === 'function') {
      const wrapped = context.middleware.wrap(name, (instance as any).execute)
      return { ...instance, execute: wrapped } as AnyTool
    }
    return instance
  }
}

export const defaultRegistry = new ToolRegistry()
