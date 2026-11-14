import { forceFinalAnswerOnMaxSteps } from './force-final-answer.js'
import { postTurn } from './post-turn.js'
import { preTurn } from './pre-turn.js'
import { runStep } from './run-step.js'
import {
  generateToolUseSummary,
  type GenerateToolUseSummary,
} from '../../services/toolUseSummary/toolUseSummaryGenerator.js'

/**
 * The phases `query()` drives each iteration. Tests pass fakes through
 * `QueryOptions.deps` instead of mocking the modules.
 */
export type QueryDeps = {
  preTurn: typeof preTurn
  runStep: typeof runStep
  postTurn: typeof postTurn
  forceFinalAnswerOnMaxSteps: typeof forceFinalAnswerOnMaxSteps
  generateToolUseSummary: GenerateToolUseSummary
}

export function productionDeps(): QueryDeps {
  return {
    preTurn,
    runStep,
    postTurn,
    forceFinalAnswerOnMaxSteps,
    generateToolUseSummary,
  }
}
