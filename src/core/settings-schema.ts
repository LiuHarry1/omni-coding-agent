/**
 * Strict Zod schema for settings files.
 * Invalid files are rejected — no silent coercion.
 */
import { z } from 'zod'

const ModelProfileSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openai-compatible']).optional(),
  model: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Set false for text-only models so image attachments are rejected up front. */
  vision: z.boolean().optional(),
  /** The model's own output-token ceiling; lets cut-off responses continue with a larger max_tokens. */
  maxOutputTokens: z.number().int().positive().optional(),
})

const ModelsSchema = z.object({
  large: ModelProfileSchema,
  medium: ModelProfileSchema.optional(),
  small: ModelProfileSchema.optional(),
})

const CompactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  microCompactKeepRecent: z.number().int().positive().optional(),
  maxFilesToRestore: z.number().int().nonnegative().optional(),
  maxTokensPerFile: z.number().int().positive().optional(),
  fileBudget: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeBasedMicroEnabled: z.boolean().optional(),
  timeBasedMicroGapMinutes: z.number().int().positive().optional(),
})

const SessionMemoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  minimumTokensToInit: z.number().int().nonnegative().optional(),
  minimumTokensBetweenUpdate: z.number().int().nonnegative().optional(),
  toolCallsBetweenUpdates: z.number().int().nonnegative().optional(),
  cacheSafe: z.boolean().optional(),
  modelTier: z.enum(['large', 'medium', 'small']).optional(),
  compactMinTokens: z.number().int().nonnegative().optional(),
  compactMaxTokens: z.number().int().positive().optional(),
  compactMinTextMessages: z.number().int().nonnegative().optional(),
})

const McpServerStdioSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const McpServerHttpSchema = z.object({
  url: z.string().url(),
  transport: z.enum(['http', 'sse']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

const McpServerSchema = z.union([McpServerStdioSchema, McpServerHttpSchema])

const LspServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    /** Omit (or use `_extensionToLanguage`) to keep a server definition disabled. */
    extensionToLanguage: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    initializationOptions: z.unknown().optional(),
    workspaceFolder: z.string().optional(),
    startupTimeout: z.number().int().positive().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
  })
  .passthrough()

const AutoMemoryNestedSchema = z.object({
  enabled: z.boolean().optional(),
  directory: z.string().optional(),
  cacheSafe: z.boolean().optional(),
  modelTier: z.enum(['large', 'medium', 'small']).optional(),
  prefetchEnabled: z.boolean().optional(),
  prefetchModelTier: z.enum(['large', 'medium', 'small']).optional(),
})

const SshHostSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  sshHost: z.string().min(1),
  sshUser: z.string().optional(),
  sshPort: z.number().int().positive().optional(),
  sshIdentityFile: z.string().optional(),
  proxyJump: z.string().optional(),
  startDirectory: z.string().optional(),
})

const BrowserConfigSchema = z.object({
  mode: z.enum(['isolated', 'extension', 'auto']).optional(),
  headless: z.boolean().optional(),
  cdpEndpoint: z.string().optional(),
  enabled: z.boolean().optional(),
  relayPort: z.number().int().positive().optional(),
  extensionToken: z.string().optional(),
  profile: z.enum(['fresh', 'persist']).optional(),
})

const ScheduledTasksConfigSchema = z.object({
  /**
   * When false, CronCreate/List/Delete are hidden and due tasks do not fire.
   * Default true when the key is omitted.
   */
  enabled: z.boolean().optional(),
})

const MarketplaceProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
  type: z.enum(['demeter', 'skills-sh']),
  baseURL: z.string().url(),
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  auth: z.enum(['none', 'cookie-proxy']).optional(),
  capabilities: z.array(z.enum(['skills', 'agents', 'bundles'])).optional(),
  allowInsecureHttp: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxDownloadBytes: z.number().int().positive().optional(),
  maxExtractBytes: z.number().int().positive().optional(),
  maxFiles: z.number().int().positive().optional(),
})

const MarketplacesConfigSchema = z.object({
  providers: z.array(MarketplaceProviderSchema),
})

const ExternalModeSchema = z.enum(['agent', 'ask', 'plan'])

const AgentsPickerSchema = z.object({
  /** Omit = show all three; [] = hide permission-mode rows. */
  modes: z.array(ExternalModeSchema).optional(),
  /** Omit = all primary agents; [] = no specialists in picker. */
  primaries: z.array(z.string().min(1)).optional(),
})

const AgentsDefaultSchema = z.object({
  mode: ExternalModeSchema.optional(),
  /** null = default coding agent (no specialist). */
  agentType: z.union([z.string().min(1), z.null()]).optional(),
})

const AgentsConfigSchema = z.object({
  picker: AgentsPickerSchema.optional(),
  default: AgentsDefaultSchema.optional(),
})

const PermissionsSchema = z.object({
  /** Directories auto-allowed for File tools (Always allow / working dirs). */
  additionalDirectories: z.array(z.string()).optional(),
  /** `Tool` / `Tool(pattern)` rules that auto-allow (desktop only). */
  allow: z.array(z.string()).optional(),
  /** `Tool` / `Tool(pattern)` rules that always deny (deny wins). */
  deny: z.array(z.string()).optional(),
  /**
   * Filesystem defaultMode (implemented subset).
   * `default` → ask outside; `dontAsk` → deny outside;
   * `bypassPermissions` → allow outside (deny still wins).
   * Legacy `acceptEdits` / `plan` coerce to `default`.
   */
  defaultMode: z.preprocess(
    value => {
      if (value === 'acceptEdits' || value === 'plan') {
        console.warn(
          `[settings] permissions.defaultMode "${value}" is not implemented; using "default"`,
        )
        return 'default'
      }
      return value
    },
    z.enum(['default', 'dontAsk', 'bypassPermissions']).optional(),
  ),
})

/** Parsed settings layer before merge into AppConfig. */
export const SettingsFileSchema = z.object({
  models: ModelsSchema.optional(),
  compaction: CompactionConfigSchema.optional(),
  sessionMemory: SessionMemoryConfigSchema.optional(),
  autoMemoryEnabled: z.boolean().optional(),
  autoMemoryDirectory: z.string().optional(),
  autoMemoryCacheSafe: z.boolean().optional(),
  autoMemoryModelTier: z.enum(['large', 'medium', 'small']).optional(),
  autoMemory: AutoMemoryNestedSchema.optional(),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  lspServers: z.record(z.string(), LspServerSchema).optional(),
  disabledTools: z.array(z.string()).optional(),
  browser: BrowserConfigSchema.optional(),
  scheduledTasks: ScheduledTasksConfigSchema.optional(),
  marketplaces: MarketplacesConfigSchema.optional(),
  agents: AgentsConfigSchema.optional(),
  permissions: PermissionsSchema.optional(),
  environments: z
    .object({
      ssh: z.array(SshHostSchema).optional(),
    })
    .optional(),
})

export type SettingsFileJson = z.infer<typeof SettingsFileSchema>
