/**
 * Code-plugin runtime.
 *
 * The declarative loader (`loader.ts`) covers the surface
 * (agents/commands/skills/MCP). This module wires the repo's pre-existing
 * `Plugin` / `PluginContext` / `PluginManager` API (`services/plugins/manager.ts`)
 * so a *code* plugin can register tools, middleware, and event handlers at
 * boot — the programmatic extension path not offered declaratively.
 *
 * The wrinkle: tools live on a durable singleton (`defaultRegistry`), but the
 * EventBus and Middleware are created fresh per chat request (see
 * `server/routes/chat.ts`). So at boot we hand plugins a *recording* context:
 * tool registrations hit `defaultRegistry` directly, while middleware hooks
 * and event subscriptions are captured here and replayed onto each
 * per-request instance via `applyPluginHooks`.
 */

import type {
  EventHandler,
  IEventBus,
  IMiddleware,
  MiddlewareHandler,
  MiddlewareHook,
  IToolRegistry,
} from '../../core/types.js'

interface RecordedMiddleware {
  hook: MiddlewareHook
  handler: MiddlewareHandler
}

interface RecordedEvent {
  event: string
  handler: EventHandler
}

const recordedMiddleware: RecordedMiddleware[] = []
const recordedEvents: RecordedEvent[] = []

/** IMiddleware that records `use()` calls instead of binding to one instance. */
class RecordingMiddleware implements IMiddleware {
  use(hook: MiddlewareHook, handler: MiddlewareHandler): void {
    recordedMiddleware.push({ hook, handler })
  }
  // Code plugins register hooks via `use`; `wrap` is only used internally by
  // the per-request Middleware, so it's a no-op pass-through here.
  wrap(
    _name: string,
    executeFn: (args: unknown, options?: unknown) => Promise<unknown>,
  ): (args: unknown, options?: unknown) => Promise<unknown> {
    return executeFn
  }
}

/** IEventBus that records `on()` subscriptions for later replay. */
class RecordingEventBus implements IEventBus {
  #prefix: string
  constructor(prefix = '') {
    this.#prefix = prefix
  }
  on(event: string, handler: EventHandler): () => void {
    const full = this.#prefix + event
    recordedEvents.push({ event: full, handler })
    return () => {
      const i = recordedEvents.findIndex(
        r => r.event === full && r.handler === handler,
      )
      if (i >= 0) recordedEvents.splice(i, 1)
    }
  }
  off(): void {
    /* no-op at boot */
  }
  emit(): void {
    /* no-op at boot — nothing to emit to yet */
  }
  scoped(prefix: string): IEventBus {
    return new RecordingEventBus(this.#prefix + prefix)
  }
  removeAllListeners(): void {
    /* no-op */
  }
}

/** Build the boot-time `PluginContext` for code plugins. */
export function createCodePluginContext(tools: IToolRegistry) {
  return {
    tools,
    events: new RecordingEventBus(),
    middleware: new RecordingMiddleware(),
  }
}

/**
 * Replay code-plugin middleware hooks and event subscriptions onto a
 * per-request `Middleware` / `EventBus`. Call once after constructing them
 * in the chat route, before the agent loop runs.
 */
export function applyPluginHooks(
  middleware: IMiddleware,
  eventBus: IEventBus,
): void {
  for (const { hook, handler } of recordedMiddleware) {
    middleware.use(hook, handler)
  }
  for (const { event, handler } of recordedEvents) {
    eventBus.on(event, handler)
  }
}

/** True once any code plugin has registered a hook (lets callers skip work). */
export function hasPluginHooks(): boolean {
  return recordedMiddleware.length > 0 || recordedEvents.length > 0
}
