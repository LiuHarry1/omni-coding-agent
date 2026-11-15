/**
 * Settings validation error formatting.
 */
import type { ZodError, ZodIssue } from 'zod'
import { SettingsFileSchema } from './schema.js'

export type ValidationError = {
  file: string
  path: string
  message: string
  expected?: string
}

function issuePath(issue: ZodIssue): string {
  if (!issue.path.length) return '(root)'
  return issue.path.map(String).join('.')
}

function formatIssue(issue: ZodIssue): string {
  if (issue.code === 'invalid_type') {
    const inv = issue as ZodIssue & { expected: string; input: unknown }
    return `Expected ${inv.expected}, received ${typeof inv.input}`
  }
  if (issue.code === 'invalid_value') {
    const inv = issue as ZodIssue & { values: unknown[] }
    return `Invalid value; expected one of: ${inv.values.map(String).join(', ')}`
  }
  if (issue.code === 'unrecognized_keys') {
    const inv = issue as ZodIssue & { keys: string[] }
    return `Unrecognized key(s): ${inv.keys.join(', ')}`
  }
  return issue.message
}

export function formatZodError(
  error: ZodError,
  file: string,
): ValidationError[] {
  return error.issues.map(issue => ({
    file,
    path: issuePath(issue),
    message: formatIssue(issue),
    expected:
      issue.code === 'invalid_type'
        ? (issue as ZodIssue & { expected: string }).expected
        : undefined,
  }))
}

export function validateSettingsFile(
  raw: unknown,
  filePath: string,
): {
  settings: import('./schema.js').SettingsFileJson | null
  errors: ValidationError[]
} {
  const result = SettingsFileSchema.safeParse(raw)
  if (!result.success) {
    return { settings: null, errors: formatZodError(result.error, filePath) }
  }
  return { settings: result.data, errors: [] }
}
