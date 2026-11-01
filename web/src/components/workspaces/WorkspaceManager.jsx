import { useEffect, useMemo, useState } from 'react'
import {
  authEnabled,
  getUser,
  isSuperUser,
  remoteEnabled,
} from '../../lib/auth.js'
import { useCapabilitiesStore } from '../../stores/capabilities-store.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useCloudWorkspaceStore } from '../../stores/cloud-workspace-store.js'
import { useWorkspaceContextStore } from '../../stores/workspace-context-store.js'
import ConfirmDialog from '../extensions/ConfirmDialog.jsx'
import ModalShell from '../extensions/ModalShell.jsx'
import StatusBadge from '../extensions/StatusBadge.jsx'
import WorkspaceTypeIcon from './WorkspaceTypeIcon.jsx'
import {
  buildCloudWorkspaceItems,
  buildDesktopWorkspaceItems,
  isWorkspaceProfileLocked,
  resolveWorkspaceCreateMethods,
} from './workspace-hub-model.js'

function ManagerToolbar({
  query,
  onQueryChange,
  count,
  showSearch,
  createLabel,
  createDisabled,
  createTitle,
  onCreate,
}) {
  return (
    <div
      className={`workspace-manager__toolbar ${showSearch ? '' : 'is-compact'}`}
    >
      {showSearch && (
        <>
          <label className='workspace-manager__search'>
            <span aria-hidden='true'>⌕</span>
            <input
              type='search'
              value={query}
              placeholder='Search workspaces'
              aria-label='Search workspaces'
              onChange={event => onQueryChange(event.target.value)}
            />
          </label>
          <span className='workspace-manager__count'>
            {count} {count === 1 ? 'workspace' : 'workspaces'}
          </span>
        </>
      )}
      <button
        type='button'
        className='extensions-button extensions-button--primary'
        disabled={createDisabled}
        title={createTitle}
        onClick={onCreate}
      >
        + {createLabel}
      </button>
    </div>
  )
}

function ManagerEmpty({ loading, query, children }) {
  return (
    <div className='workspace-manager__empty'>
      {loading ? (
        <>
          <span className='spinner' aria-hidden='true' />
          <p>Loading workspaces…</p>
        </>
      ) : (
        <>
          <span aria-hidden='true'>◇</span>
          <p>{query ? 'No workspaces match your search.' : children}</p>
        </>
      )}
    </div>
  )
}

function RenameWorkspaceDialog({ workspace, onClose }) {
  const rename = useCloudWorkspaceStore(state => state.rename)
  const [name, setName] = useState(workspace?.name || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setName(workspace?.name || '')
    setBusy(false)
    setError(null)
  }, [workspace])

  const submit = async event => {
    event.preventDefault()
    const nextName = name.trim()
    if (!workspace || !nextName || nextName === workspace.name) return
    setBusy(true)
    setError(null)
    try {
      await rename(workspace.id, nextName)
      onClose()
    } catch (err) {
      setError(err?.message || 'Could not rename this workspace')
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={Boolean(workspace)}
      onClose={busy ? undefined : onClose}
      title='Rename workspace'
      size='small'
      shouldCloseOnBackdrop={!busy}
    >
      <form className='extensions-form' onSubmit={submit}>
        <label className='extensions-field'>
          <span>Workspace name</span>
          <input
            autoFocus
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={event => setName(event.target.value)}
          />
        </label>
        {error && (
          <div
            className='extensions-alert extensions-alert--error'
            role='alert'
          >
            {error}
          </div>
        )}
        <div className='extensions-form__actions'>
          <button
            type='button'
            className='extensions-button'
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type='submit'
            className='extensions-button extensions-button--primary'
            disabled={busy || !name.trim() || name.trim() === workspace?.name}
          >
            {busy ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function CloudWorkspaceRow({
  workspace,
  menuOpen,
  chatBusy,
  onMenuToggle,
  onSelect,
  onRename,
  onStop,
  onDelete,
}) {
  const ready = workspace.status === 'ready'
  const status = workspace.pending ? 'importing' : workspace.status

  return (
    <article className='workspace-manager-row'>
      <div className='workspace-manager-row__main'>
        <span className='workspace-manager-row__icon' aria-hidden='true'>
          <WorkspaceTypeIcon
            kind={workspace.source?.kind === 'git' ? 'git' : 'cloud'}
          />
        </span>
        <div className='workspace-manager-row__copy'>
          <div className='workspace-manager-row__title'>
            <strong>{workspace.name}</strong>
            {workspace.pending && (
              <StatusBadge status='importing'>Importing</StatusBadge>
            )}
            {workspace.status === 'error' && (
              <StatusBadge status={status}>Failed</StatusBadge>
            )}
            {workspace.runtimeStatus === 'stopped' && (
              <StatusBadge status='stopped'>Stopped</StatusBadge>
            )}
          </div>
          <span
            className={`workspace-manager-row__meta ${
              workspace.source?.kind === 'git' ? 'is-path' : ''
            }`}
            title={workspace.sourceDisplay.label}
          >
            {workspace.sourceDisplay.label}
          </span>
        </div>
        {workspace.current ? (
          <span className='workspace-manager-row__current'>
            <span aria-hidden='true'>✓</span> Current
          </span>
        ) : (
          <button
            type='button'
            className='extensions-button workspace-manager-row__use'
            disabled={!ready || chatBusy}
            title={chatBusy ? 'Wait for the current chat to finish' : ''}
            onClick={onSelect}
          >
            Use
          </button>
        )}
        <div
          className='workspace-manager-row__menu'
          onClick={event => event.stopPropagation()}
        >
          <button
            type='button'
            className='workspace-manager-row__menu-trigger'
            aria-label={`Actions for ${workspace.name}`}
            aria-expanded={menuOpen}
            aria-haspopup='menu'
            onClick={onMenuToggle}
          >
            •••
          </button>
          {menuOpen && (
            <div className='workspace-manager-row__menu-popover' role='menu'>
              <button type='button' role='menuitem' onClick={onRename}>
                Rename
              </button>
              <button
                type='button'
                role='menuitem'
                disabled={
                  !ready || chatBusy || workspace.runtimeStatus === 'stopped'
                }
                onClick={onStop}
              >
                Stop runtime
              </button>
              <button
                type='button'
                role='menuitem'
                className='is-danger'
                disabled={chatBusy && workspace.current}
                onClick={onDelete}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {workspace.error && (
        <div className='workspace-manager-row__error' role='alert'>
          {workspace.error}
        </div>
      )}
    </article>
  )
}

function CloudWorkspaceManager({ methods, onAddWorkspace }) {
  const workspaces = useCloudWorkspaceStore(state => state.workspaces)
  const currentId = useCloudWorkspaceStore(state => state.currentId)
  const pendingId = useCloudWorkspaceStore(state => state.pendingId)
  const limit = useCloudWorkspaceStore(state => state.limit)
  const loaded = useCloudWorkspaceStore(state => state.loaded)
  const enabled = useCloudWorkspaceStore(state => state.enabled)
  const load = useCloudWorkspaceStore(state => state.load)
  const refresh = useCloudWorkspaceStore(state => state.refresh)
  const select = useCloudWorkspaceStore(state => state.select)
  const stop = useCloudWorkspaceStore(state => state.stop)
  const remove = useCloudWorkspaceStore(state => state.remove)
  const isStreaming = useChatStore(state => state.isStreaming)
  const sessionLoading = useChatStore(state => state.sessionLoading)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [menuId, setMenuId] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [pendingAction, setPendingAction] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let active = true
    const request = loaded && enabled ? refresh() : load()
    void Promise.resolve(request)
      .then(result => {
        if (active && result === false) {
          setLoadError('Cloud workspace lifecycle is unavailable.')
        } else if (active) {
          setLoadError(null)
        }
      })
      .catch(err => {
        if (active) {
          setLoadError(err?.message || 'Could not load cloud workspaces')
        }
      })
    return () => {
      active = false
    }
  }, [enabled, load, loaded, refresh])

  useEffect(() => {
    if (!menuId) return undefined
    const closeMenu = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      setMenuId(null)
    }
    document.addEventListener('click', closeMenu)
    document.addEventListener('keydown', closeMenu)
    return () => {
      document.removeEventListener('click', closeMenu)
      document.removeEventListener('keydown', closeMenu)
    }
  }, [menuId])

  const items = useMemo(
    () => buildCloudWorkspaceItems(workspaces, currentId, pendingId),
    [currentId, pendingId, workspaces],
  )
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter(workspace =>
      `${workspace.name} ${workspace.sourceDisplay.label} ${workspace.cwd}`
        .toLowerCase()
        .includes(needle),
    )
  }, [items, query])
  const chatBusy = isStreaming || sessionLoading
  const atLimit = limit != null && workspaces.length >= limit

  const selectWorkspace = workspace => {
    setActionError(null)
    if (select(workspace.id) !== true) {
      setActionError('Wait for the current chat before changing workspace.')
    }
  }

  const confirmAction = async () => {
    if (!confirmation) return
    setPendingAction(true)
    setActionError(null)
    try {
      if (confirmation.type === 'delete') {
        await remove(confirmation.workspace.id)
      } else {
        await stop(confirmation.workspace.id)
      }
      setConfirmation(null)
    } catch (err) {
      setActionError(err?.message || 'Workspace action failed')
    } finally {
      setPendingAction(false)
    }
  }

  return (
    <>
      <div className='workspace-manager'>
        <ManagerToolbar
          query={query}
          onQueryChange={setQuery}
          count={items.length}
          showSearch={items.length > 7}
          createLabel='Add workspace'
          createDisabled={
            !loaded || !enabled || atLimit || methods.length === 0
          }
          createTitle={
            !loaded
              ? 'Loading workspaces'
              : !enabled
                ? 'Cloud workspace lifecycle is unavailable'
                : atLimit
                  ? `Workspace limit of ${limit} reached`
                  : 'Create workspace'
          }
          onCreate={onAddWorkspace}
        />
        {actionError && !confirmation && (
          <div
            className='extensions-alert extensions-alert--error workspace-manager__alert'
            role='alert'
          >
            {actionError}
          </div>
        )}
        {loadError && (
          <div
            className='extensions-alert extensions-alert--error workspace-manager__alert'
            role='alert'
          >
            {loadError}
          </div>
        )}
        <div className='workspace-manager__list thin-scrollbar'>
          {(!loaded || filteredItems.length === 0) && (
            <ManagerEmpty loading={!loaded} query={query}>
              Create a blank workspace or clone a repository to get started.
            </ManagerEmpty>
          )}
          {filteredItems.map(workspace => (
            <CloudWorkspaceRow
              key={workspace.id}
              workspace={workspace}
              menuOpen={menuId === workspace.id}
              chatBusy={chatBusy}
              onMenuToggle={event => {
                event.stopPropagation()
                setMenuId(value =>
                  value === workspace.id ? null : workspace.id,
                )
              }}
              onSelect={() => selectWorkspace(workspace)}
              onRename={() => {
                setMenuId(null)
                setRenaming(workspace)
              }}
              onStop={() => {
                setMenuId(null)
                setActionError(null)
                setConfirmation({ type: 'stop', workspace })
              }}
              onDelete={() => {
                setMenuId(null)
                setActionError(null)
                setConfirmation({ type: 'delete', workspace })
              }}
            />
          ))}
        </div>
      </div>
      <RenameWorkspaceDialog
        workspace={renaming}
        onClose={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={
          confirmation?.type === 'delete'
            ? 'Delete workspace?'
            : 'Stop workspace runtime?'
        }
        message={
          confirmation?.type === 'delete' ? (
            <p>
              <strong>{confirmation.workspace.name}</strong> and all files,
              commits, and uncommitted changes in its volume will be permanently
              deleted.
            </p>
          ) : (
            <p>
              The runtime for <strong>{confirmation?.workspace.name}</strong>{' '}
              will stop. Its files remain available and start again when needed.
            </p>
          )
        }
        confirmLabel={
          confirmation?.type === 'delete' ? 'Delete workspace' : 'Stop runtime'
        }
        variant={confirmation?.type === 'delete' ? 'danger' : 'primary'}
        pending={pendingAction}
        error={actionError}
        onClose={() => {
          setConfirmation(null)
          setActionError(null)
        }}
        onConfirm={() => void confirmAction()}
      />
    </>
  )
}

function DesktopWorkspaceRow({ workspace, locked, chatBusy, onSelect }) {
  const kindLabel =
    workspace.kind === 'ssh'
      ? 'SSH'
      : workspace.kind === 'local'
        ? 'Local'
        : 'Environment'

  return (
    <article className='workspace-manager-row'>
      <div className='workspace-manager-row__main'>
        <span className='workspace-manager-row__icon' aria-hidden='true'>
          <WorkspaceTypeIcon kind={workspace.kind} />
        </span>
        <div className='workspace-manager-row__copy'>
          <div className='workspace-manager-row__title'>
            <strong>{workspace.name}</strong>
          </div>
          <span
            className='workspace-manager-row__meta is-path'
            title={workspace.handle.cwd}
          >
            {kindLabel} · {workspace.handle.cwd}
          </span>
        </div>
        {workspace.current ? (
          <span className='workspace-manager-row__current'>
            <span aria-hidden='true'>✓</span> Current
          </span>
        ) : (
          <button
            type='button'
            className='extensions-button workspace-manager-row__use'
            disabled={locked || chatBusy}
            title={
              locked
                ? 'This workspace is managed by your administrator'
                : chatBusy
                  ? 'Wait for the current chat to finish'
                  : ''
            }
            onClick={onSelect}
          >
            Use
          </button>
        )}
      </div>
    </article>
  )
}

function DesktopWorkspaceManager({ methods, locked, onAddWorkspace }) {
  const handle = useWorkspaceContextStore(state => state.handle)
  const label = useWorkspaceContextStore(state => state.label)
  const recentHandles = useWorkspaceContextStore(state => state.recentHandles)
  const select = useWorkspaceContextStore(state => state.select)
  const isStreaming = useChatStore(state => state.isStreaming)
  const sessionLoading = useChatStore(state => state.sessionLoading)
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState(null)
  const remoteAvailable = remoteEnabled()
  const availableMethods = useMemo(
    () => methods.filter(method => method.id !== 'ssh' || remoteAvailable),
    [methods, remoteAvailable],
  )
  const allItems = useMemo(
    () => buildDesktopWorkspaceItems({ handle, label, recentHandles }),
    [handle, label, recentHandles],
  )
  const items = useMemo(
    () => (locked ? allItems.filter(item => item.current) : allItems),
    [allItems, locked],
  )
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter(workspace =>
      `${workspace.name} ${workspace.label} ${workspace.handle.cwd} ${workspace.handle.environmentId}`
        .toLowerCase()
        .includes(needle),
    )
  }, [items, query])
  const chatBusy = isStreaming || sessionLoading

  const selectWorkspace = workspace => {
    setActionError(null)
    const changed = select(workspace.handle, {
      label: workspace.label,
      profile: 'desktop',
    })
    if (!changed) {
      setActionError('Wait for the current chat before changing workspace.')
    }
  }

  return (
    <>
      <div className='workspace-manager'>
        <ManagerToolbar
          query={query}
          onQueryChange={setQuery}
          count={items.length}
          showSearch={items.length > 7}
          createLabel='Add workspace'
          createDisabled={locked || availableMethods.length === 0}
          createTitle={
            locked
              ? 'This workspace is managed by your administrator'
              : 'Add workspace'
          }
          onCreate={onAddWorkspace}
        />
        {locked && (
          <div className='extensions-info-banner workspace-manager__alert'>
            <div>
              <strong>Managed workspace</strong>
              <span>
                Your account is pinned to this server-managed directory.
              </span>
            </div>
          </div>
        )}
        {actionError && (
          <div
            className='extensions-alert extensions-alert--error workspace-manager__alert'
            role='alert'
          >
            {actionError}
          </div>
        )}
        <div className='workspace-manager__list thin-scrollbar'>
          {filteredItems.length === 0 && (
            <ManagerEmpty query={query}>
              Open a local folder or connect to an SSH host to get started.
            </ManagerEmpty>
          )}
          {filteredItems.map(workspace => (
            <DesktopWorkspaceRow
              key={workspace.id}
              workspace={workspace}
              locked={locked}
              chatBusy={chatBusy}
              onSelect={() => selectWorkspace(workspace)}
            />
          ))}
        </div>
      </div>
    </>
  )
}

export default function WorkspaceManager({ open, onClose, onAddWorkspace }) {
  const loaded = useCapabilitiesStore(state => state.loaded)
  const manifest = useCapabilitiesStore(state => state.manifest)
  const workspaceLabel = useWorkspaceContextStore(
    state => state.label || state.cwd,
  )
  const methods = useMemo(
    () => resolveWorkspaceCreateMethods(manifest),
    [manifest],
  )
  const cloud = manifest.profile === 'cloud'
  const locked = isWorkspaceProfileLocked(
    manifest.profile,
    authEnabled(),
    isSuperUser(getUser()),
  )
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={'Workspaces'}
      subtitle={
        workspaceLabel
          ? `Current: ${workspaceLabel}`
          : 'Choose where chats and tools run.'
      }
      className='workspace-manager-modal'
      size='large'
    >
      {!loaded ? (
        <div className='extensions-blank-state'>
          <span className='spinner' aria-hidden='true' />
          <p>Loading workspace capabilities…</p>
        </div>
      ) : !manifest.workspace.enabled ? (
        <div className='extensions-blank-state'>
          <span className='extensions-blank-state__mark'>◇</span>
          <h3>Workspace management is unavailable</h3>
          <p>{manifest.workspace.reason || 'Disabled by server policy.'}</p>
        </div>
      ) : cloud ? (
        <CloudWorkspaceManager
          methods={methods}
          onAddWorkspace={onAddWorkspace}
        />
      ) : (
        <DesktopWorkspaceManager
          methods={methods}
          locked={locked}
          onAddWorkspace={onAddWorkspace}
        />
      )}
    </ModalShell>
  )
}
