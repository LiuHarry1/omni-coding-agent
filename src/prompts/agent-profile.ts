/**
 * Main-thread agent profile prompt.
 * When session.agentType is set, the profile body REPLACES the default
 * system prompt for that turn.
 */
import type { AgentDefinition } from '../core/types.js'
import { computeSimpleEnvInfo } from '../constants/prompts.js'
import { setCwd } from '../utils/workspace/cwd.js'
import { workspaceBoundaryPromptSection } from '../utils/permissions/workspace-boundary-prompt.js'
import { resolveSettings } from '../utils/settings/manager.js'
import { getBrowserHandoff } from '../browser/manager.js'
import { browserAgentSessionSection } from './browser-agent-session.js'

function resolveBrowserMode(cwd: string): 'isolated' | 'extension' {
  try {
    return resolveSettings(cwd).config.browser?.mode === 'extension'
      ? 'extension'
      : 'isolated'
  } catch {
    return 'isolated'
  }
}

/**
 * Build the effective system prompt for a primary agent profile.
 * REPLACE default agent/ask/plan prompts with the markdown body, then append
 * a short environment block and project rules (unless omitProjectRules).
 * `memoryAppend` is independent of omitProjectRules — private agent memory
 * must still reach browser / Plan profiles that strip the rules block.
 */
export async function getSystemPromptForAgentProfile(
  profile: AgentDefinition,
  cwd: string,
  projectRules?: string,
  sessionId?: string,
  modelId = '',
  memoryAppend?: string,
): Promise<string> {
  setCwd(cwd)
  const env =
    (await computeSimpleEnvInfo(modelId)) + workspaceBoundaryPromptSection(cwd)

  const session =
    profile.agentType === 'browser'
      ? `\n\n${browserAgentSessionSection(
          resolveBrowserMode(cwd),
          getBrowserHandoff(sessionId) ?? undefined,
        )}`
      : ''

  const rulesAppend =
    !profile.omitProjectRules && projectRules ? `\n\n${projectRules}` : ''
  const memorySection = memoryAppend?.trim() ? `\n\n${memoryAppend}` : ''

  return `${profile.systemPrompt}${session}\n\n${env}${rulesAppend}${memorySection}`
}
