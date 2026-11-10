import * as fs from 'fs'
import * as path from 'path'
import { isValidWorkspaceId } from '../../execution/providers/cloud/containers.js'

export type CloudWorkspaceSource =
  { kind: 'git'; url: string; ref?: string } | { kind: 'empty' }

export type CloudWorkspaceStatus = 'provisioning' | 'ready' | 'error'

export type CloudWorkspaceRecord = {
  version: 1
  id: string
  ownerEmail: string
  name: string
  source: CloudWorkspaceSource
  status: CloudWorkspaceStatus
  error?: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    fs.rmSync(filePath, { force: true })
    fs.renameSync(tmp, filePath)
  }
}

/** One JSON file per workspace under a process-scoped data directory. */
export class CloudWorkspaceStore {
  private cache: Map<string, CloudWorkspaceRecord> | null = null

  constructor(readonly dir: string) {}

  private load(): Map<string, CloudWorkspaceRecord> {
    if (this.cache) return this.cache
    const records = new Map<string, CloudWorkspaceRecord>()
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      // No workspaces yet.
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!isValidWorkspaceId(id)) continue
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(this.dir, name), 'utf8'),
        ) as CloudWorkspaceRecord
        if (parsed?.id === id) records.set(id, parsed)
      } catch (err) {
        console.warn(
          `[cloud-workspaces] skipping unreadable record ${name}: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
    this.cache = records
    return records
  }

  list(): CloudWorkspaceRecord[] {
    return [...this.load().values()]
  }

  /** Discard process cache and reload the registry from disk. */
  refresh(): CloudWorkspaceRecord[] {
    this.cache = null
    return this.list()
  }

  get(id: string): CloudWorkspaceRecord | undefined {
    return this.load().get(id)
  }

  put(record: CloudWorkspaceRecord): void {
    atomicWriteJson(path.join(this.dir, `${record.id}.json`), record)
    this.load().set(record.id, record)
  }

  delete(id: string): void {
    if (!isValidWorkspaceId(id)) return
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true })
    this.load().delete(id)
  }
}
