import { useCallback, useEffect, useState } from 'react'
import { workspaceApi } from '../../lib/api/workspace.js'
import { isDesktop, pickWorkspaceDir } from '../../lib/desktop.js'
import { useCloudWorkspaceStore } from '../../stores/cloud-workspace-store.js'
import { useWorkspaceContextStore } from '../../stores/workspace-context-store.js'
import EnvironmentPicker from '../EnvironmentPicker.jsx'
import ModalShell from '../extensions/ModalShell.jsx'

function joinDirectory(dir, name) {
  const separator =
    String(dir).includes('\\') && !String(dir).includes('/') ? '\\' : '/'
  return `${String(dir).replace(/[\\/]$/, '')}${separator}${name}`
}

function CloudCreateForm({ methodId, onCancel, onCreated }) {
  const create = useCloudWorkspaceStore(state => state.create)
  const [repoUrl, setRepoUrl] = useState('')
  const [ref, setRef] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const cloning = methodId === 'clone'
  const canCreate = !busy && (!cloning || repoUrl.trim())

  const submit = async event => {
    event.preventDefault()
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const workspace = await create({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(cloning
          ? {
              repoUrl: repoUrl.trim(),
              ...(ref.trim() ? { ref: ref.trim() } : {}),
            }
          : {}),
      })
      onCreated(workspace)
    } catch (err) {
      setError(err?.message || 'Could not create this workspace')
      setBusy(false)
    }
  }

  return (
    <form className='workspace-create-form' onSubmit={submit}>
      {cloning && (
        <>
          <label className='extensions-field'>
            <span>Repository URL</span>
            <input
              autoFocus
              value={repoUrl}
              placeholder='https://git.example.com/team/repository.git'
              disabled={busy}
              onChange={event => setRepoUrl(event.target.value)}
            />
            <small>Public HTTPS Git repositories are supported.</small>
          </label>
          <details className='workspace-create__advanced'>
            <summary>Branch and workspace name</summary>
            <div className='workspace-create__advanced-fields'>
              <label className='extensions-field'>
                <span>
                  Branch or tag <em>optional</em>
                </span>
                <input
                  value={ref}
                  placeholder='Default branch'
                  disabled={busy}
                  onChange={event => setRef(event.target.value)}
                />
              </label>
              <label className='extensions-field'>
                <span>
                  Name <em>optional</em>
                </span>
                <input
                  value={name}
                  maxLength={80}
                  placeholder='Repository name'
                  disabled={busy}
                  onChange={event => setName(event.target.value)}
                />
              </label>
            </div>
          </details>
        </>
      )}
      {!cloning && (
        <div className='workspace-create-callout'>
          A blank workspace starts with an empty Git repository.
        </div>
      )}
      {!cloning && (
        <label className='extensions-field'>
          <span>
            Name <em>optional</em>
          </span>
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder='Blank workspace'
            disabled={busy}
            onChange={event => setName(event.target.value)}
          />
        </label>
      )}
      {error && (
        <div className='extensions-alert extensions-alert--error' role='alert'>
          {error}
        </div>
      )}
      <div className='extensions-form__actions'>
        <button
          type='button'
          className='extensions-button'
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type='submit'
          className='extensions-button extensions-button--primary'
          disabled={!canCreate}
        >
          {busy
            ? 'Creating…'
            : cloning
              ? 'Clone repository'
              : 'Create workspace'}
        </button>
      </div>
    </form>
  )
}

function ElectronFolderPicker({ onCancel, onCreated }) {
  const selectWorkspace = useWorkspaceContextStore(state => state.select)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const dir = await pickWorkspaceDir()
      if (!dir) {
        setBusy(false)
        return
      }
      const selected = selectWorkspace(
        { environmentId: 'local', cwd: dir },
        { label: dir, profile: 'desktop' },
      )
      if (!selected) {
        throw new Error('Wait for the current chat before changing workspace')
      }
      onCreated({ environmentId: 'local', cwd: dir }, dir)
    } catch (err) {
      setError(err?.message || 'Could not open this folder')
      setBusy(false)
    }
  }

  return (
    <div className='workspace-create-form'>
      <div className='workspace-create-callout'>
        Choose an existing project folder with the system folder picker.
      </div>
      {error && (
        <div className='extensions-alert extensions-alert--error' role='alert'>
          {error}
        </div>
      )}
      <div className='extensions-form__actions'>
        <button
          type='button'
          className='extensions-button'
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type='button'
          className='extensions-button extensions-button--primary'
          disabled={busy}
          onClick={() => void choose()}
        >
          {busy ? 'Opening…' : 'Choose folder…'}
        </button>
      </div>
    </div>
  )
}

function LocalFolderBrowser({ startDir, onCancel, onCreated }) {
  const selectWorkspace = useWorkspaceContextStore(state => state.select)
  const [directory, setDirectory] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)

  const loadDirectory = useCallback(async dir => {
    setBusy(true)
    setError(null)
    try {
      setDirectory(await workspaceApi.listDir(dir || '.'))
    } catch (err) {
      setError(err?.message || 'Could not browse this directory')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadDirectory(startDir || '.')
  }, [loadDirectory, startDir])

  const selectDirectory = dir => {
    const selected = selectWorkspace(
      { environmentId: 'local', cwd: dir },
      { label: dir, profile: 'desktop' },
    )
    if (!selected) {
      setError('Wait for the current chat before changing workspace')
      return false
    }
    onCreated({ environmentId: 'local', cwd: dir }, dir)
    return true
  }

  const createFolder = async () => {
    const name = newFolderName.trim()
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      setError('Enter a folder name without slashes')
      return
    }
    const target = joinDirectory(directory.dir, name)
    setBusy(true)
    setError(null)
    try {
      await workspaceApi.createFolder(target)
      if (!selectDirectory(target)) setBusy(false)
    } catch (err) {
      setError(err?.message || 'Could not create this folder')
      setBusy(false)
    }
  }

  const entries =
    directory?.entries?.filter(entry => entry.isDir || entry.type === 'dir') ||
    []

  return (
    <div className='workspace-folder-browser'>
      <div className='workspace-folder-browser__toolbar'>
        <button
          type='button'
          className='extensions-button extensions-button--compact'
          disabled={
            busy || !directory?.parent || directory.parent === directory.dir
          }
          onClick={() => void loadDirectory(directory.parent)}
        >
          Up
        </button>
        <code title={directory?.dir}>{directory?.dir || startDir || '.'}</code>
        <button
          type='button'
          className='extensions-button extensions-button--compact'
          disabled={busy || !directory}
          onClick={() => setCreatingFolder(value => !value)}
        >
          + Folder
        </button>
      </div>
      {creatingFolder && (
        <div className='workspace-folder-browser__new'>
          <input
            autoFocus
            value={newFolderName}
            placeholder='Folder name'
            disabled={busy}
            onChange={event => setNewFolderName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void createFolder()
              }
              if (event.key === 'Escape') setCreatingFolder(false)
            }}
          />
          <button
            type='button'
            className='extensions-button extensions-button--compact'
            disabled={busy || !newFolderName.trim()}
            onClick={() => void createFolder()}
          >
            Create
          </button>
        </div>
      )}
      {error && (
        <div className='extensions-alert extensions-alert--error' role='alert'>
          {error}
        </div>
      )}
      <div className='workspace-folder-browser__list thin-scrollbar'>
        {busy && !directory && <div className='extensions-empty'>Loading…</div>}
        {!busy && entries.length === 0 && (
          <div className='extensions-empty'>No subfolders</div>
        )}
        {entries.map(entry => (
          <button
            key={entry.path}
            type='button'
            onClick={() => void loadDirectory(entry.path)}
          >
            <span aria-hidden='true'>▸</span>
            <span>{entry.name}</span>
          </button>
        ))}
      </div>
      <div className='extensions-form__actions workspace-folder-browser__actions'>
        <button
          type='button'
          className='extensions-button'
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type='button'
          className='extensions-button extensions-button--primary'
          disabled={busy || !directory}
          onClick={() => selectDirectory(directory.dir)}
        >
          Open this folder
        </button>
      </div>
    </div>
  )
}

function DesktopCreateMethod({ methodId, startDir, onCancel, onCreated }) {
  if (methodId === 'local-folder') {
    return isDesktop() ? (
      <ElectronFolderPicker onCancel={onCancel} onCreated={onCreated} />
    ) : (
      <LocalFolderBrowser
        startDir={startDir}
        onCancel={onCancel}
        onCreated={onCreated}
      />
    )
  }

  if (methodId === 'ssh') {
    return (
      <div className='workspace-ssh-browser'>
        <EnvironmentPicker allowedKinds={['ssh']} onBound={onCreated} />
        <div className='extensions-form__actions'>
          <button
            type='button'
            className='extensions-button'
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className='extensions-blank-state'>
      <p>This workspace method is not available in the desktop profile.</p>
    </div>
  )
}

export default function WorkspaceCreateDialog({
  open,
  onClose,
  methods,
  initialMethodId,
  profile,
  startDir,
  onCreated,
}) {
  const [methodId, setMethodId] = useState(
    initialMethodId || methods[0]?.id || '',
  )

  useEffect(() => {
    if (!open) return
    const requested = methods.find(method => method.id === initialMethodId)
    setMethodId(requested?.id || methods[0]?.id || '')
  }, [initialMethodId, methods, open])

  const activeMethod =
    methods.find(method => method.id === methodId) || methods[0]
  const directMethod = Boolean(
    initialMethodId && methods.some(method => method.id === initialMethodId),
  )
  const titleByMethod = {
    clone: 'Clone repository',
    blank: 'Create cloud workspace',
    'local-folder': 'Open local folder',
    ssh: 'Connect with SSH',
  }
  const title = directMethod
    ? titleByMethod[activeMethod?.id] || 'Add workspace'
    : 'Add workspace'

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      subtitle={
        activeMethod?.description ||
        (profile === 'cloud'
          ? 'Create an isolated repository and runtime.'
          : 'Choose where chats and tools run.')
      }
      size='small'
      className='workspace-create-modal'
    >
      <div className='workspace-create'>
        {!directMethod && methods.length > 1 && (
          <div
            className='extensions-segmented workspace-create__methods'
            role='tablist'
            aria-label='Workspace method'
          >
            {methods.map(method => (
              <button
                key={method.id}
                type='button'
                role='tab'
                aria-selected={method.id === activeMethod?.id}
                className={method.id === activeMethod?.id ? 'is-active' : ''}
                onClick={() => setMethodId(method.id)}
              >
                {method.label}
              </button>
            ))}
          </div>
        )}
        {profile === 'cloud' && activeMethod ? (
          <CloudCreateForm
            key={activeMethod.id}
            methodId={activeMethod.id}
            onCancel={onClose}
            onCreated={onCreated}
          />
        ) : (
          activeMethod && (
            <DesktopCreateMethod
              key={activeMethod.id}
              methodId={activeMethod.id}
              startDir={startDir}
              onCancel={onClose}
              onCreated={onCreated}
            />
          )
        )}
      </div>
    </ModalShell>
  )
}
