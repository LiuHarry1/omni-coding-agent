import type { LlmProfile } from './types.js'

/**
 * Published context windows of first-party models, matched against the
 * lowercased model id in order. Gateways (`openai-compatible`) often cap the
 * window below what the model supports, so their profiles only get a window
 * when one is configured.
 */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\[1m\]$/, 1_000_000],
  [/^claude-/, 200_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o/, 128_000],
  [/^gpt-5/, 400_000],
  [/^o[134](-|$)/, 200_000],
]

export function knownContextWindow(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  return CONTEXT_WINDOWS.find(([pattern]) => pattern.test(id))?.[1]
}

/** The profile's context window: configured, else known for first-party models. */
export function resolveContextWindow(profile: LlmProfile): number | undefined {
  if (profile.contextWindow) return profile.contextWindow
  if (profile.provider === 'openai-compatible') return undefined
  return knownContextWindow(profile.model)
}
