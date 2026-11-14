import { createAnthropic } from '@ai-sdk/anthropic'
import type {
  ProviderStrategy,
  ThinkingConfig,
  AgentStreamTextExtras,
} from '../types.js'

/**
 * Anthropic 4.6+ models expect extended thinking via `thinking.type: "adaptive"`.
 * `type: "enabled"` + `budget_tokens` is for older models (pre-Opus 4.6).
 * @see @ai-sdk/anthropic `anthropicLanguageModelOptions` schema.
 */
function needsAdaptive(modelId: string): boolean {
  // Normalize dots to dashes so dotted model ids match dashed forms.
  const m = modelId.toLowerCase().replace(/\./g, '-')
  if (
    m.includes('opus-4-') ||
    m.includes('sonnet-4-') ||
    m.includes('haiku-4-')
  )
    return true
  if (/claude-[^/]+-4-[6-9]/.test(m)) return true
  return false
}

const DEFAULT_BUDGETS = { low: 4_000, medium: 12_000, high: 32_000 } as const

function thinkingToExtras(
  t: ThinkingConfig,
  modelId: string,
): AgentStreamTextExtras {
  if (t.mode === 'off') return {}

  // Adaptive models: Anthropic picks budget; we just pass display.
  if (t.mode === 'auto' || needsAdaptive(modelId)) {
    return {
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      },
    }
  }

  let budgetTokens: number
  if (t.mode === 'budget') budgetTokens = t.tokens
  else budgetTokens = DEFAULT_BUDGETS[t.mode]

  return {
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens },
      },
    },
  }
}

export const anthropicStrategy: ProviderStrategy = {
  id: 'anthropic',
  build(p) {
    const client = createAnthropic({
      name: p.name ?? 'anthropic',
      baseURL: p.baseURL,
      apiKey: p.apiKey,
    })
    return {
      chatModel: id => client.languageModel(id),
      streamTextExtras: () => thinkingToExtras(p.thinking, p.model),
      defaultModelId: () => p.model,
      // Single 5-minute "ephemeral" breakpoint, attached by the agent to
      // the last message of each request. Anthropic then caches the full
      // prefix (system + tools + history) up to that point; subsequent
      // requests reuse it for ~10% of the normal input price. Older cache
      // entries from prior steps still serve as prefix matches even when
      // their cache_control marker is no longer on the message — Anthropic
      // picks the longest-matching cached prefix.
      cacheControlOptions: () => ({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      }),
      supportsToolResultContentBlocks: () => true,
      supportsNativePdf: () => true,
      supportsImageInput: () => p.vision !== false,
      maxOutputTokenCap: () => p.maxOutputTokens,
      describe: () => {
        const adaptive = p.thinking.mode === 'auto' || needsAdaptive(p.model)
        if (p.thinking.mode === 'off')
          return `anthropic thinking=off model=${p.model}`
        if (adaptive)
          return `anthropic thinking=adaptive(${p.thinking.mode}) model=${p.model}`
        const budget =
          p.thinking.mode === 'budget'
            ? p.thinking.tokens
            : DEFAULT_BUDGETS[p.thinking.mode as 'low' | 'medium' | 'high']
        return `anthropic thinking=enabled budget=${budget} model=${p.model}`
      },
    }
  },
}
