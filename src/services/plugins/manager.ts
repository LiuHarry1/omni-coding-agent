import type { Plugin, PluginContext } from '../../core/types.js'

interface PluginEntry {
  plugin: Plugin
  state: 'registered' | 'active' | 'error' | 'destroyed'
}

export class PluginManager {
  #plugins = new Map<string, PluginEntry>()
  #context: PluginContext
  #initialized = false

  constructor(context: PluginContext) {
    this.#context = context
  }

  register(plugin: Plugin): void {
    if (!plugin.name) throw new Error('Plugin must have a name')
    if (this.#plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`)
    }
    this.#plugins.set(plugin.name, { plugin, state: 'registered' })
  }

  async initAll(): Promise<void> {
    if (this.#initialized) return
    for (const [name, entry] of this.#plugins) {
      if (entry.state !== 'registered') continue
      try {
        await entry.plugin.init(this.#context)
        entry.state = 'active'
        console.log(`[plugin] Initialized: ${name}`)
      } catch (err) {
        entry.state = 'error'
        console.error(
          `[plugin] Failed to init "${name}": ${(err as Error).message}`,
        )
      }
    }
    this.#initialized = true
  }

  async destroyAll(): Promise<void> {
    for (const [name, entry] of this.#plugins) {
      if (entry.state !== 'active') continue
      try {
        await entry.plugin.destroy?.()
        entry.state = 'destroyed'
      } catch (err) {
        console.error(
          `[plugin] Error destroying "${name}": ${(err as Error).message}`,
        )
      }
    }
    this.#initialized = false
  }

  list(): Array<{
    name: string
    version?: string
    description?: string
    state: string
  }> {
    return [...this.#plugins.entries()].map(([name, { plugin, state }]) => ({
      name,
      version: plugin.version,
      description: plugin.description,
      state,
    }))
  }

  get(name: string): Plugin | undefined {
    return this.#plugins.get(name)?.plugin
  }

  get context(): PluginContext {
    return this.#context
  }
}
