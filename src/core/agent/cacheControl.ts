/**
 * Prompt-caching helpers. Attach `cache_control` breakpoints to the end of
 * the system prompt and to the LAST message of each request when the
 * provider supports it (Anthropic). For everything else they are no-ops.
 *
 * # Why only the last message?
 *
 * Anthropic's prompt caching works on prefix-match: a request with a
 * `cache_control` marker caches everything from the start of the request
 * up to and including the marker. The next request, even if it has its
 * marker at a different position, can still HIT that earlier cache as
 * long as its prefix matches byte-for-byte (Anthropic picks the longest-
 * matching cached prefix automatically).
 *
 * So one marker on the latest message is enough to:
 *   - WRITE: cache the full request prefix (system + tools + history)
 *   - READ:  next turn's request shares the same prefix bytes up to the
 *            previous turn's marker, and that cache is reused.
 *
 * The 4-breakpoint pattern in Anthropic docs is for finer-grained reuse
 * across multi-tenant workflows. For a single-session agent loop, one
 * trailing breakpoint captures ~all the value.
 *
 * # Why also the system prompt?
 *
 * A request only reads a cache entry written at one of its own breakpoint
 * positions. After compaction rewrites the history, the old message-level
 * entries no longer line up, so without a breakpoint after the system prompt
 * even the unchanged [tools + system] prefix would be sent uncached.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

import type { SystemModelMessage } from 'ai'
import type { IProvider } from '../../services/llm/types.js'
import type { Message } from '../types.js'

/**
 * The `system` argument for a request: the prompt as one block ending in a
 * cache breakpoint when the provider supports one, else the plain string.
 */
export function systemWithCacheBreakpoint(
  system: string,
  provider: IProvider,
): string | SystemModelMessage[] {
  const opts = provider.cacheControlOptions?.()
  if (!opts || !system) return system
  return [
    {
      role: 'system',
      content: system,
      providerOptions: opts as SystemModelMessage['providerOptions'],
    },
  ]
}

/**
 * Returns a NEW messages array with the cache-control marker attached to
 * the last element's `providerOptions`. Returns the input array reference
 * unchanged when the provider doesn't support cache control or messages
 * is empty.
 *
 * The mutation is shallow — only the last message object is replaced;
 * earlier messages keep their identity (matters for the `attachTokenUsage`
 * WeakMap keys in `core/context.ts`).
 */
export function applyCacheControlBreakpoint(
  messages: Message[],
  provider: IProvider,
): Message[] {
  const opts = provider.cacheControlOptions?.()
  if (!opts || messages.length === 0) return messages

  const lastIdx = messages.length - 1
  const last = messages[lastIdx]

  // providerOptions isn't on our Message union but the AI SDK accepts
  // arbitrary extra fields on messages, so we type-erase via `unknown`
  // and let the SDK's runtime validation handle it.
  const lastWithCache = {
    ...last,
    providerOptions: opts,
  } as unknown as Message

  const out = messages.slice()
  out[lastIdx] = lastWithCache
  return out
}
