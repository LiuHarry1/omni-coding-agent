export interface ConfigStorageEntry {
  path: string
  name: string
  isDir: boolean
  size: number
  mtimeMs: number
  mode?: number
}

export interface ConfigStorageInspection extends ConfigStorageEntry {
  exists: boolean
}

export interface ConfigStorageReadResult {
  buffer: Buffer
  size: number
  mtimeMs: number
  mode?: number
}

export interface ConfigStorageExport {
  localPath: string
  isDir: boolean
  size: number
}

export interface ConfigStoragePort {
  /** Stable, non-secret label used only in metadata responses. */
  readonly displayName: string

  /**
   * Validate an existing config root. This must not create the root: read-only
   * requests must never materialize a workspace `.ai-agent` directory.
   */
  initialize(): Promise<void>

  inspect(
    relative: string,
    options?: {
      allowRoot?: boolean
      requireExists?: boolean
      createRoot?: boolean
    },
  ): Promise<ConfigStorageInspection>

  list(relative: string): Promise<ConfigStorageEntry[]>
  readFile(relative: string, maxBytes: number): Promise<ConfigStorageReadResult>

  /**
   * Atomically create or replace a regular file. Implementations must reject
   * symbolic links and special files rather than following them.
   */
  writeFile(
    relative: string,
    data: Buffer,
    options: {
      createOnly: boolean
      expectedMtimeMs?: number
      mode?: number
    },
  ): Promise<ConfigStorageEntry>

  ensureDirectory(relative: string): Promise<ConfigStorageEntry>
  remove(relative: string): Promise<void>

  /**
   * Copy a validated entry to a local temporary directory. The returned path
   * is always beneath `destinationDir` and contains no symbolic links.
   */
  exportEntry(
    relative: string,
    destinationDir: string,
  ): Promise<ConfigStorageExport>

  /**
   * Publish a validated local file or directory at a previously absent config
   * path. Publication is staged beside the destination before it becomes
   * visible.
   */
  publishEntry(localPath: string, relative: string): Promise<ConfigStorageEntry>

  getGeneration(): Promise<number>
  bumpGeneration(): Promise<number>
}
