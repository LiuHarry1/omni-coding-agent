/**
 * Leaf helpers for chat `max_tokens`. Kept out of query/helpers so the
 * openai-compatible strategy can import them without a llm↔settings cycle
 * (`Cannot access 'DEFAULT_PROFILE' before initialization`).
 */

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

export function getMaxOutputTokens(): number {
  const parsed = parseInt(process.env.AGENT_MAX_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_OUTPUT_TOKENS
}

/** Always send max_tokens — LiteLLM Qwen defaults to 128000 when omitted. */
export function applyMaxTokensToChatBody(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args.max_tokens === 'number' && args.max_tokens > 0) return args
  return { ...args, max_tokens: getMaxOutputTokens() }
}
