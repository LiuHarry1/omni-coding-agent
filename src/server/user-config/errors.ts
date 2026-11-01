export class UserConfigError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'UserConfigError'
  }
}

export function userConfigErrorBody(error: unknown): {
  error: string
  code: string
} {
  if (error instanceof UserConfigError) {
    return { error: error.message, code: error.code }
  }
  return { error: 'Internal server error', code: 'EINTERNAL' }
}
