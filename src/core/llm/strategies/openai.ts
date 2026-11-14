import { createOpenAI } from '@ai-sdk/openai'
import type {
  ProviderStrategy,
  ThinkingConfig,
  AgentStreamTextExtras,
} from '../types.js'
import { createDebugFetch } from './debug-fetch.js'

/**
 * Map provider-agnostic thinking → OpenAI Responses API `reasoning*` extras.
 * - off    → no reasoning fields (model decides; usually no extended thinking)
 * - auto   → reasoningSummary=auto, no explicit effort
 * - low/medium/high → reasoningEffort
 * - budget → mapped down to `high` (OpenAI has no token budget knob)
 */
function thinkingToExtras(t: ThinkingConfig): AgentStreamTextExtras {
  if (t.mode === 'off') return {}

  let reasoningEffort: 'low' | 'medium' | 'high' | undefined
  if (t.mode === 'low' || t.mode === 'medium' || t.mode === 'high') {
    reasoningEffort = t.mode
  } else if (t.mode === 'budget') {
    reasoningEffort = 'high'
  }

  return {
    providerOptions: {
      openai: {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        reasoningSummary: 'auto',
        store: false,
      },
    },
  }
}

export const openaiStrategy: ProviderStrategy = {
  id: 'openai',
  build(p) {
    const client = createOpenAI({
      name: p.name ?? 'openai',
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      fetch: createDebugFetch(),
    })
    return {
      chatModel: id => client.responses(id),
      streamTextExtras: () => thinkingToExtras(p.thinking),
      defaultModelId: () => p.model,
      // Responses API maps content parts to `input_image`; keep this in sync
      // if `chatModel` ever switches to `client.chat(id)`.
      supportsToolResultContentBlocks: () => true,
      // Do not assume Responses accepts PDF file parts until verified per gateway.
      supportsNativePdf: () => false,
      supportsImageInput: () => p.vision !== false,
      maxOutputTokenCap: () => p.maxOutputTokens,
      describe: () =>
        `openai(responses) thinking=${p.thinking.mode}${
          p.thinking.mode === 'budget' ? `(${p.thinking.tokens})` : ''
        } model=${p.model}`,
    }
  },
}
