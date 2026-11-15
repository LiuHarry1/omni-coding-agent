import {
  ASK_USER_QUESTION_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import {
  EXPLORE_AGENT_TYPE,
  PLAN_AGENT_TYPE,
} from '../tools/AgentTool/index.js'
import {
  getPlanModeAgentCount,
  getPlanModeExploreAgentCount,
} from '../utils/plan-config.js'
import { PLAN_PHASE4_SECTION } from './plan-phase4.js'

export interface PlanPromptOptions {
  planFilePath: string
  planExists: boolean
}

/**
 * The plan-mode workflow, sent as a reminder while plan mode is active so
 * the system prompt stays the same in every mode.
 */
export function planModeInstructions(options: PlanPromptOptions): string {
  const { planFilePath, planExists } = options
  const agentCount = getPlanModeAgentCount()
  const exploreAgentCount = getPlanModeExploreAgentCount()

  const planFileInfo = planExists
    ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the ${EDIT_FILE_TOOL_NAME} tool.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the ${WRITE_FILE_TOOL_NAME} tool.`

  const multiPlanAgentGuidance =
    agentCount > 1
      ? `- **Multiple agents**: Use up to ${agentCount} agents for complex tasks that benefit from different perspectives

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture
`
      : ''

  const sections = [
    'Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.',
    '',
    '## Plan File Info:',
    planFileInfo,
    'You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.',
    '',
    '## Plan Workflow',
    '',
    '### Phase 1: Initial Understanding',
    `Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${EXPLORE_AGENT_TYPE} subagent type.`,
    '',
    "1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.",
    '',
    `2. **Launch up to ${exploreAgentCount} ${EXPLORE_AGENT_TYPE} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.`,
    "   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.",
    '   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.',
    `   - Quality over quantity - ${exploreAgentCount} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)`,
    '   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns',
    '',
    '### Phase 2: Design',
    'Goal: Design an implementation approach.',
    '',
    `Launch ${PLAN_AGENT_TYPE} agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.`,
    '',
    `You can launch up to ${agentCount} agent(s) in parallel.`,
    '',
    '**Guidelines:**',
    '- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives',
    '- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)',
    multiPlanAgentGuidance,
    'In the agent prompt:',
    '- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces',
    '- Describe requirements and constraints',
    '- Request a detailed implementation plan',
    '',
    '### Phase 3: Review',
    "Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.",
    '1. Read the critical files identified by agents to deepen your understanding',
    "2. Ensure that the plans align with the user's original request",
    `3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user`,
    '',
    PLAN_PHASE4_SECTION,
    '',
    `### Phase 5: Call ${EXIT_PLAN_MODE_TOOL_NAME}`,
    `At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning.`,
    `This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it's for these 2 reasons`,
    '',
    `**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.`,
    '',
    `NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`,
    '',
    '## Tool usage (read-only during Phases 1-3)',
    `- Exploration agents: ${EXPLORE_AGENT_TYPE} (Phase 1), ${PLAN_AGENT_TYPE} (Phase 2)`,
    `- Direct reads when needed: ${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, ${WEB_SEARCH_TOOL_NAME}, ${WEB_FETCH_TOOL_NAME}`,
    `- Clarification: ${ASK_USER_QUESTION_TOOL_NAME} (Phase 3)`,
    `- Approval: ${EXIT_PLAN_MODE_TOOL_NAME} (Phase 5 — user cannot see the plan until you call this)`,
    '',
    `Do not reference "the plan" in ${ASK_USER_QUESTION_TOOL_NAME} questions — the user cannot see it in the UI until ${EXIT_PLAN_MODE_TOOL_NAME} is called.`,
    '',
    '## TodoWrite',
    `${TODO_WRITE_TOOL_NAME} is optional during planning. You do NOT need to call it before ${EXIT_PLAN_MODE_TOOL_NAME}. After the user approves the plan, update your todo list with ${TODO_WRITE_TOOL_NAME} if tracking progress would help.`,
  ]

  return sections.join('\n')
}
