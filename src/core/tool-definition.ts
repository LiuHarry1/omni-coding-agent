/**
 * One place for what a tool is assumed to be when its definition does not
 * say: not safe to run in parallel, and not read-only. A definition has to
 * opt in to the permissive answer.
 */
import type {
  AnyTool,
  ToolContext,
  ToolDefinition,
  ValidationResult,
} from './types.js'

const TOOL_DEFAULTS = {
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
}

export type DefinedTool = ToolDefinition &
  Required<Pick<ToolDefinition, 'isConcurrencySafe' | 'isReadOnly'>>

/** Complete a definition with the defaults for whatever it leaves out. */
export function defineTool(def: ToolDefinition): DefinedTool {
  return { ...TOOL_DEFAULTS, ...def }
}

/**
 * Whether a call can change nothing. Asked without input it means "every
 * call this tool can make". Unknown tools and failing predicates are not
 * read-only.
 */
export function isToolReadOnly(
  def: ToolDefinition | undefined,
  input?: unknown,
): boolean {
  if (!def?.isReadOnly) return false
  try {
    return def.isReadOnly(input) === true
  } catch {
    return false
  }
}

const VALIDATE_INPUT = Symbol('tool.validateInput')

type BoundValidateInput = (input: unknown) => Promise<ValidationResult>

/**
 * Create a tool for one request. The definition's `validateInput` needs the
 * same cwd and context as `execute`, so it is bound here and travels with
 * the instance.
 */
export function instantiateTool(
  def: ToolDefinition,
  cwd: string,
  context: ToolContext,
): AnyTool {
  const instance = def.create(cwd, context)
  const validateInput = def.validateInput
  if (!validateInput) return instance
  const bound: BoundValidateInput = async input =>
    validateInput(input, { cwd, context })
  return Object.assign(instance, { [VALIDATE_INPUT]: bound })
}

/**
 * Run the tool's own check of a call's arguments: whether this call can
 * succeed at all, beyond what the schema says. Tools without one pass.
 */
export async function validateToolCall(
  tool: AnyTool | undefined,
  input: unknown,
): Promise<ValidationResult> {
  const bound = (
    tool as { [VALIDATE_INPUT]?: BoundValidateInput } | undefined
  )?.[VALIDATE_INPUT]
  if (!bound) return { result: true }
  try {
    return await bound(input)
  } catch (err) {
    return {
      result: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
