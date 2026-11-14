import type { LanguageModel } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'

export type ProviderId = 'openai' | 'anthropic' | 'openai-compatible'

/**
 * Provider-agnostic thinking/reasoning intent.
 *
 * The user only expresses *intent* here. Each provider strategy translates this
 * into its own wire format (OpenAI `reasoningEffort`, Anthropic `thinking.type`, …).
 *
 * - `off`     — no extended thinking (default).
 * - `auto`    — let the provider pick a sensible default (Anthropic adaptive,
 *               OpenAI summary-only).
 * - `low`/`medium`/`high` — strength buckets, mapped per provider.
 * - `budget`  — explicit token budget (Anthropic native; OpenAI maps to `high`).
 */
export type ThinkingConfig =
  | { mode: 'off' }
  | { mode: 'auto' }
  | { mode: 'low' | 'medium' | 'high' }
  | { mode: 'budget'; tokens: number }

/**
 * Single, flat user-facing config — the only shape stored on disk / sent over
 * the wire. Switching provider is a one-line change.
 */
export interface LlmProfile {
  provider: ProviderId
  name?: string
  baseURL: string
  apiKey: string
  model: string
  thinking: ThinkingConfig
  /**
   * Set false for text-only models behind an OpenAI-compatible gateway.
   * Composer images are then rejected up front and PDFs fall back to their
   * text layer, instead of the gateway 400-ing mid-turn. Default true.
   */
  vision?: boolean
  /**
   * The model's own output-token ceiling. When set above the default
   * max_tokens, steps that continue after an output-limit cut ask for more.
   */
  maxOutputTokens?: number
}

export type AgentStreamTextExtras = {
  providerOptions?: ProviderOptions
}

export interface IProvider {
  chatModel(modelId: string): LanguageModel
  streamTextExtras(): AgentStreamTextExtras
  defaultModelId(): string
  describe(): string
  /**
   * Per-message `providerOptions` payload that marks a cache breakpoint
   * (Anthropic prompt caching). Returns `undefined` for providers that
   * either don't support prompt caching or do it automatically (OpenAI).
   *
   * Caller attaches the returned object to the LAST message of each
   * request so Anthropic caches everything up to that point. The next
   * request finds the longest-matching prefix and reads from cache.
   *
   * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
   */
  cacheControlOptions?(): Record<string, unknown> | undefined
  /**
   * Whether this provider serializes `ToolResultOutput.type: 'content'` into
   * real multimodal blocks. Anthropic Messages and the OpenAI Responses API
   * do; chat-completions endpoints `JSON.stringify` the array instead, which
   * would dump base64 into the prompt. When false, `projectMessagesForApi`
   * relocates tool-result images into a following user message.
   *
   * Declared per strategy rather than derived from `ProviderId` because it
   * depends on which endpoint the strategy picks (`responses()` vs `chat()`).
   * Omitted → treated as unsupported.
   */
  supportsToolResultContentBlocks?(): boolean
  /**
   * Whether the model accepts native PDF document / file parts (the
   * `document` block). When false, Read(PDF) renders pages via pdftoppm and
   * attaches images instead. Omitted → false.
   */
  supportsNativePdf?(): boolean
  /**
   * Whether the model accepts image parts. Drives whether composer images and
   * rasterized PDF pages are sent at all. Omitted → true.
   */
  supportsImageInput?(): boolean
  /** The profile's `maxOutputTokens`. Omitted/undefined → unknown, never raised. */
  maxOutputTokenCap?(): number | undefined
}

export interface ProviderStrategy {
  readonly id: ProviderId
  build(profile: LlmProfile): IProvider
}
