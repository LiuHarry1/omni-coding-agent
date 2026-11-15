/**
 * MCP prompts as slash commands: `/mcp__<server>__<prompt> args`.
 *
 * They come from live servers rather than from files, so they are resolved
 * against the MCP manager instead of the slash registry.
 */
import type { MCPManager, MCPPromptInfo, MCPPromptMessage } from './manager.js'

export type McpPromptSource = Pick<MCPManager, 'listPrompts' | 'getPrompt'>

const PREFIX = 'mcp__'
const SLASH_LINE_RE = /^\/(mcp__[a-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/i

function normalize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function mcpPromptCommandName(prompt: MCPPromptInfo): string {
  return `${PREFIX}${normalize(prompt.server)}__${normalize(prompt.name)}`
}

/** True for a message that can only be meant as an MCP prompt. */
export function isMcpPromptSlash(message: string): boolean {
  return SLASH_LINE_RE.test(message.trimEnd())
}

/**
 * Split what the user typed after the command into the prompt's arguments,
 * in declared order. Quotes group words; the last argument takes whatever is
 * left, so a one-argument prompt gets the whole line.
 */
export function parsePromptArguments(
  raw: string,
  names: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {}
  let rest = raw.trim()
  for (let i = 0; i < names.length && rest; i++) {
    const name = names[i]!
    const quoted = rest.match(/^"((?:[^"\\]|\\.)*)"(?=\s|$)|^'([^']*)'(?=\s|$)/)
    if (quoted) {
      values[name] =
        quoted[1] !== undefined
          ? quoted[1].replace(/\\(["\\])/g, '$1')
          : quoted[2]!
      rest = rest.slice(quoted[0].length).trimStart()
      continue
    }
    if (i === names.length - 1) {
      values[name] = rest
      rest = ''
      continue
    }
    const word = rest.match(/^\S+/)![0]
    values[name] = word
    rest = rest.slice(word.length).trimStart()
  }
  return values
}

/** What the prompt says, as the text of one user message. */
export function promptMessagesToText(messages: MCPPromptMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    const content = message.content as {
      type: string
      text?: string
      resource?: { uri?: string; text?: string }
    }
    let text: string
    if (content.type === 'text') {
      text = content.text ?? ''
    } else if (content.type === 'resource') {
      const { uri, text: body } = content.resource ?? {}
      text = body
        ? `<resource uri="${uri ?? ''}">\n${body}\n</resource>`
        : `[binary resource ${uri ?? ''} omitted]`
    } else {
      text = `[${content.type} content omitted]`
    }
    if (!text.trim()) continue
    // A prompt can script both sides of a conversation; keep who said what.
    parts.push(message.role === 'assistant' ? `Assistant: ${text}` : text)
  }
  return parts.join('\n\n')
}

function argumentHint(prompt: MCPPromptInfo): string | undefined {
  if (prompt.arguments.length === 0) return undefined
  return prompt.arguments
    .map(argument =>
      argument.required ? `<${argument.name}>` : `[${argument.name}]`,
    )
    .join(' ')
}

export interface McpPromptSlashEntry {
  name: string
  description: string
  kind: 'mcp-prompt'
  argumentHint?: string
  source: 'mcp'
  server: string
}

/** The prompts on offer, in the shape the slash menu lists. */
export async function listMcpPromptSlashEntries(
  source: McpPromptSource,
): Promise<McpPromptSlashEntry[]> {
  const prompts = await source.listPrompts()
  return prompts.map(prompt => ({
    name: mcpPromptCommandName(prompt),
    description: prompt.description ?? `Prompt from ${prompt.server}`,
    kind: 'mcp-prompt',
    argumentHint: argumentHint(prompt),
    source: 'mcp',
    server: prompt.server,
  }))
}

/**
 * Expand `/mcp__server__prompt args` into the prompt's text. Null when the
 * message is not such a line.
 */
export async function resolveMcpPromptSlash(
  message: string,
  source: McpPromptSource,
): Promise<{ text: string } | { error: string } | null> {
  const match = message.trimEnd().match(SLASH_LINE_RE)
  if (!match) return null
  const command = match[1]!.toLowerCase()
  const rawArgs = match[2] ?? ''

  const prompts = await source.listPrompts()
  const prompt = prompts.find(
    candidate => mcpPromptCommandName(candidate).toLowerCase() === command,
  )
  if (!prompt) {
    const known = prompts.map(p => `/${mcpPromptCommandName(p)}`)
    return {
      error:
        `Unknown MCP prompt: /${match[1]}\n\n` +
        (known.length > 0
          ? `Available MCP prompts: ${known.join(', ')}`
          : 'No connected MCP server offers prompts.'),
    }
  }

  const args = parsePromptArguments(
    rawArgs,
    prompt.arguments.map(argument => argument.name),
  )
  const missing = prompt.arguments
    .filter(argument => argument.required && !args[argument.name])
    .map(argument => argument.name)
  if (missing.length > 0) {
    return {
      error: `/${match[1]} needs ${missing.join(', ')}.\n\nUsage: /${mcpPromptCommandName(prompt)} ${argumentHint(prompt) ?? ''}`,
    }
  }

  try {
    const messages = await source.getPrompt(prompt.server, prompt.name, args)
    const text = promptMessagesToText(messages)
    if (!text) {
      return { error: `/${match[1]} returned an empty prompt.` }
    }
    return { text }
  } catch (err) {
    return {
      error: `Error running /${match[1]}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
