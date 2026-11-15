/**
 * Wraps fetch so we can inspect what the OpenAI SDK POSTs to `/v1/responses`.
 * Set `OPENAI_DEBUG_REQUEST=1` to dump every body, or leave unset to dump only failures.
 */
export function createDebugFetch(): typeof fetch {
  const dumpAll = process.env.OPENAI_DEBUG_REQUEST === '1'
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const body = init?.body
    const response = await fetch(input, init)

    const shouldDump = dumpAll || !response.ok
    if (
      shouldDump &&
      body &&
      typeof body === 'string' &&
      url.includes('/responses')
    ) {
      try {
        const parsed = JSON.parse(body)
        const summary = {
          status: response.status,
          model: parsed.model,
          input_count: Array.isArray(parsed.input)
            ? parsed.input.length
            : undefined,
          input_types: Array.isArray(parsed.input)
            ? parsed.input.map(
                (it: { type?: string; role?: string; id?: string }) => ({
                  type: it.type ?? `role:${it.role}`,
                  id: it.id
                    ? `${it.id.slice(0, 24)}…(${it.id.length})`
                    : undefined,
                }),
              )
            : undefined,
          tool_count: Array.isArray(parsed.tools)
            ? parsed.tools.length
            : undefined,
          include: parsed.include,
          reasoning: parsed.reasoning,
        }
        console.error(
          '[openai-debug] /responses request:',
          JSON.stringify(summary, null, 2),
        )
      } catch {
        console.error('[openai-debug] failed to parse request body')
      }
    }
    return response
  }
}
