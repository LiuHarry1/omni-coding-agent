import { environmentsApi } from './api/environments.js'
import { workspaceApi } from './api/workspace.js'

export function isRemoteEnvironmentId(environmentId) {
  return Boolean(
    environmentId &&
    environmentId !== 'local' &&
    !String(environmentId).startsWith('local'),
  )
}

function shouldShowEntry(name, showHidden) {
  if (name === '.' || name === '..') return false
  if (!name.startsWith('.')) return true
  if (name === '.ai-agent' || name === '.env' || name.startsWith('.env.')) {
    return true
  }
  return showHidden
}

function normalizeListPayload(data, dirPath, showHidden) {
  const dir = data.dir || dirPath
  const cleaned = dir.replace(/\/$/, '') || '/'
  const slash = cleaned.lastIndexOf('/')
  const parent = slash > 0 ? cleaned.slice(0, slash) : cleaned
  const entries = (data.entries || [])
    .filter(entry => shouldShowEntry(entry.name, showHidden))
    .map(entry => ({
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir ?? entry.type === 'dir',
    }))
  return { dir, parent, entries }
}

/**
 * One filesystem client for the current WorkspaceHandle. Local Desktop
 * workspaces retain `/workspace/*`; Cloud and SSH use `/environments/fs/*`.
 */
export function createEnvironmentFsClient(handle) {
  const environmentId = handle?.environmentId || 'local'
  const rootPath = handle?.cwd || ''
  if (!isRemoteEnvironmentId(environmentId)) {
    return {
      listDir: (dirPath, showHidden) =>
        workspaceApi.listDir(dirPath, showHidden),
      searchFiles: (query, dir = rootPath, limit = 15, showHidden = false) =>
        workspaceApi.searchFiles(query, dir, limit, showHidden),
      getFile: workspaceApi.getFile,
      createFile: workspaceApi.createFile,
      saveFile: workspaceApi.saveFile,
      createFolder: workspaceApi.createFolder,
      removeEntry: workspaceApi.removeEntry,
      uploadFiles: workspaceApi.uploadFiles,
      gitStatus: () => workspaceApi.gitStatus(),
      gitDiff: workspaceApi.gitDiff,
      downloadPath: workspaceApi.downloadPath,
    }
  }

  return {
    listDir: async (dirPath, showHidden) =>
      normalizeListPayload(
        await environmentsApi.listDir(environmentId, dirPath),
        dirPath,
        showHidden,
      ),
    searchFiles: (query, dir = rootPath, limit = 15, showHidden = false) =>
      environmentsApi.searchFiles(environmentId, query, dir, limit, showHidden),
    getFile: path => environmentsApi.getFile(environmentId, path),
    createFile: (path, content) =>
      environmentsApi.createFile(environmentId, path, content),
    saveFile: (path, content, mtimeMs) =>
      environmentsApi.saveFile(environmentId, path, content, mtimeMs),
    createFolder: path => environmentsApi.createFolder(environmentId, path),
    removeEntry: path => environmentsApi.removeEntry(environmentId, path),
    uploadFiles: (dir, files, onProgress) =>
      environmentsApi.uploadFiles(environmentId, dir, files, onProgress),
    gitStatus: () => environmentsApi.gitStatus(environmentId, rootPath),
    gitDiff: path => environmentsApi.gitDiff(environmentId, rootPath, path),
    downloadPath: path => environmentsApi.downloadPath(environmentId, path),
  }
}
