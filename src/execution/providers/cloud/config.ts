import { WORKER_BUNDLE_NAME } from '../../../brand.js'

/**
 * Cloud workspaces (one Docker container + volume per workspace).
 *
 * Env:
 *   CLOUD_WORKSPACES          "docker" turns the feature on.
 *   WORKSPACE_IMAGE           image with git, node and the baked Worker.
 *   WORKSPACE_NETWORK         bridge network the containers join.
 *   WORKSPACE_MEMORY / WORKSPACE_CPUS / WORKSPACE_PIDS_LIMIT  resource caps.
 *   WORKSPACE_IDLE_MINUTES    idle minutes before the container is removed.
 *   WORKSPACE_MAX_PER_USER    workspace count limit per user.
 *   WORKSPACE_INSTANCE        owner label; give each control plane sharing a
 *                             Docker host its own value so idle sweeps never
 *                             remove another instance's containers.
 */
export type CloudWorkspaceConfig = {
  image: string
  instance: string
  network: string
  namePrefix: string
  memory: string
  cpus: string
  pidsLimit: number
  idleMs: number
  maxPerUser: number
  /** uid:gid the container and every exec run as. */
  user: string
  homeDir: string
  /** Volume mount point; the only persistent path in a container. */
  volumeMount: string
  /** Project checkout inside the volume; the Session cwd. */
  repoDir: string
  workerPath: string
  cloneTimeoutMs: number
}

export function isCloudWorkspacesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    String(env.CLOUD_WORKSPACES ?? '')
      .trim()
      .toLowerCase() === 'docker'
  )
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function nonEmpty(raw: string | undefined, fallback: string): string {
  const v = raw?.trim()
  return v ? v : fallback
}

const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

function instanceName(raw: string | undefined): string {
  const v = nonEmpty(raw, 'default')
  if (!INSTANCE_RE.test(v)) {
    throw new Error(`Invalid WORKSPACE_INSTANCE: ${JSON.stringify(v)}`)
  }
  return v
}

export function loadCloudWorkspaceConfig(
  env: NodeJS.ProcessEnv = process.env,
): CloudWorkspaceConfig {
  return {
    image: nonEmpty(env.WORKSPACE_IMAGE, 'agent-workspace:latest'),
    instance: instanceName(env.WORKSPACE_INSTANCE),
    network: nonEmpty(env.WORKSPACE_NETWORK, 'agent-ws'),
    namePrefix: 'agent-ws-',
    memory: nonEmpty(env.WORKSPACE_MEMORY, '2g'),
    cpus: nonEmpty(env.WORKSPACE_CPUS, '2'),
    pidsLimit: positiveInt(env.WORKSPACE_PIDS_LIMIT, 512),
    idleMs: positiveInt(env.WORKSPACE_IDLE_MINUTES, 30) * 60_000,
    maxPerUser: positiveInt(env.WORKSPACE_MAX_PER_USER, 5),
    user: '1000:1000',
    homeDir: '/home/agent',
    volumeMount: '/workspace',
    repoDir: '/workspace/repo',
    workerPath: `/opt/agent/dist/worker/${WORKER_BUNDLE_NAME}`,
    cloneTimeoutMs: 10 * 60_000,
  }
}
