/** Why the query loop went around again. Names follow Claude Code's queryLoop. */
export type Continue =
  | { reason: 'next_turn' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  /** An approved plan was answered with text only; nudge towards a tool call. */
  | { reason: 'plan_build_kickoff' }
  /** A Stop hook refused the ending; its feedback went back to the model. */
  | { reason: 'stop_hook_blocking' }

/** Why the query loop returned. */
export type Terminal =
  | { reason: 'completed' }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  /** `summarized`: the forced tool-less final answer produced text. */
  | { reason: 'max_turns'; turnCount: number; summarized: boolean }
  | { reason: 'model_error'; error: string }
  /** Output-limit recovery ran out of attempts. */
  | { reason: 'max_output_tokens' }
  /** A tool hook answered `continue: false`. `notice` is shown to the user. */
  | { reason: 'hook_stopped'; notice: string }
  /** A Stop hook answered `continue: false`. */
  | { reason: 'stop_hook_prevented'; notice: string }
