/**
 * AskUserQuestion tool — multiple-choice prompts to the user.
 *
 * Schema:
 *   - `questions: [...]` 1-4 entries.
 *   - Each question: `{ question, header (<=12 char chip), options,
 *     multiSelect }`. Options: 2-4 per question, each
 *     `{ label, description, preview? }`.
 *   - Uniqueness: question texts unique across the batch; option labels
 *     unique within a single question.
 *
 * Flow: emit `ask_user_question` on the per-request EventBus + register a
 * Promise on `question-broker`. The frontend renders the questions, the
 * user picks options, and the client POSTs to
 * `/ask_user_question/answer`, which resolves the promise. A 5-minute
 * timeout keeps headless deploys from hanging forever.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { ToolDefinition } from '../../core/types.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../constants/tool_names.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../constants/tool_names.js'
import {
  registerQuestion,
  type QuestionAnnotation,
} from '../../core/brokers/question-broker.js'

const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

const DESCRIPTION =
  'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.'

const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ${EXIT_PLAN_MODE_TOOL_NAME}. If you need plan approval, use ${EXIT_PLAN_MODE_TOOL_NAME} instead.
`

const questionOptionSchema = z.object({
  label: z
    .string()
    .describe(
      'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
    ),
  description: z
    .string()
    .describe(
      'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
    ),
  preview: z
    .string()
    .optional()
    .describe(
      'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
    ),
})

const questionSchema = z.object({
  question: z
    .string()
    .describe(
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
    ),
  header: z
    .string()
    .describe(
      `Very short label displayed as a chip/tag (max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
    ),
  options: z
    .array(questionOptionSchema)
    .min(2)
    .max(4)
    .describe(
      `The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.`,
    ),
  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
    ),
})

const annotationSchema = z.object({
  preview: z
    .string()
    .optional()
    .describe(
      'The preview content of the selected option, if the question used previews.',
    ),
  notes: z
    .string()
    .optional()
    .describe('Free-text notes the user added to their selection.'),
})

const annotationsSchema = z
  .record(z.string(), annotationSchema)
  .optional()
  .describe(
    'Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.',
  )

const UNIQUENESS_REFINE = {
  check: (data: {
    questions: { question: string; options: { label: string }[] }[]
  }) => {
    const questions = data.questions.map(q => q.question)
    if (questions.length !== new Set(questions).size) return false
    for (const question of data.questions) {
      const labels = question.options.map(opt => opt.label)
      if (labels.length !== new Set(labels).size) return false
    }
    return true
  },
  message:
    'Question texts must be unique, option labels must be unique within each question',
} as const

const inputSchema = z
  .object({
    questions: z
      .array(questionSchema)
      .min(1)
      .max(4)
      .describe('Questions to ask the user (1-4 questions)'),
    answers: z
      .record(z.string(), z.string())
      .optional()
      .describe('User answers collected by the permission component'),
    annotations: annotationsSchema,
    metadata: z
      .object({
        source: z
          .string()
          .optional()
          .describe(
            'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
          ),
      })
      .optional()
      .describe(
        'Optional metadata for tracking and analytics purposes. Not displayed to user.',
      ),
  })
  .refine(UNIQUENESS_REFINE.check, { message: UNIQUENESS_REFINE.message })

type AskUserInput = z.infer<typeof inputSchema>

// Cap waits at 5 minutes so headless deploys without a connected
// frontend don't hang the agent loop forever.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export type AskUserQuestionOutput = {
  text: string
  answers?: Record<string, string>
  answered: boolean
}

export const AskUserQuestionOutputSchema = z.object({
  text: z.string(),
  answers: z.record(z.string(), z.string()).optional(),
  answered: z.boolean(),
})

export const definition: ToolDefinition = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: DESCRIPTION,
  shouldDefer: true,
  isConcurrencySafe: () => false,
  // Mode D — status chrome for UI; text for model
  outputSchema: AskUserQuestionOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: (output as AskUserQuestionOutput).text,
    }
  },
  create(_cwd, context) {
    return tool({
      description: `${DESCRIPTION}\n\n${ASK_USER_QUESTION_TOOL_PROMPT}`,
      inputSchema,
      execute: async (input: AskUserInput) => {
        const id = randomUUID()

        // Emit on the per-request EventBus; SSE clients render the
        // question(s) and POST back to /ask_user_question/answer.
        context.wire.askUserQuestion(id, input.questions)

        const result = await registerQuestion(id, DEFAULT_TIMEOUT_MS)

        if (!result.answered) {
          const text =
            result.reason === 'timeout'
              ? `No answer received within ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s. If you were asking for approval of an action, treat the silence as "no": do not take that action, and say what still needs the user's approval. Otherwise proceed with a reasonable default and note the assumption in your reply.`
              : `Question was cancelled.`
          return {
            data: { text, answered: false } satisfies AskUserQuestionOutput,
          }
        }

        const { answers, annotations } = result.value

        const answersText = Object.entries(answers)
          .map(([questionText, answer]) => {
            const annotation: QuestionAnnotation | undefined =
              annotations?.[questionText]
            const parts = [`"${questionText}"="${answer}"`]
            if (annotation?.preview) {
              parts.push(`selected preview:\n${annotation.preview}`)
            }
            if (annotation?.notes) {
              parts.push(`user notes: ${annotation.notes}`)
            }
            return parts.join(' ')
          })
          .join(', ')

        const text = `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`
        return {
          data: {
            text,
            answers,
            answered: true,
          } satisfies AskUserQuestionOutput,
        }
      },
    })
  },
}
