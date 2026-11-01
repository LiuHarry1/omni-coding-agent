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
import StatusBadge from '../extensions/StatusBadge.jsx'
import WorkspaceCreateDialog from './WorkspaceCreateDialog.jsx'
import WorkspaceTypeIcon from './WorkspaceTypeIcon.jsx'
import {
  buildCloudWorkspaceItems,
  buildDesktopWorkspaceItems,
  isWorkspaceProfileLocked,
  resolveWorkspaceCreateMethods,
} from './workspace-hub-model.js'

function WorkspaceRow({ item, cloud, busy, onSelect }) {
  const unavailable = cloud && item.status !== 'ready'
  const monoMeta = !cloud || item.source?.kind === 'git'
  const iconKind = cloud
    ? item.source?.kind === 'git'
      ? 'git'
      : 'cloud'
    : item.kind
  const meta = cloud
    ? item.pending
      ? 'Importing repository…'
      : item.sourceDisplay.label
    : `${item.kind === 'ssh' ? 'SSH' : 'Local'} · ${item.handle.cwd}`

  return (
    <button
      type='button'
      className={`workspace-quick-row ${item.current ? 'is-current' : ''}`}
      disabled={unavailable || (busy && !item.current)}
      title={
        unavailable
          ? 'This workspace is not ready yet'
          : busy && !item.current
            ? 'Wait for the current chat to finish'
            : item.name
      }
      aria-current={item.current ? 'true' : undefined}
      onClick={() => onSelect(item)}
    >
      <span className='workspace-quick-row__icon' aria-hidden='true'>
        <WorkspaceTypeIcon kind={iconKind} />
      </span>
      <span className='workspace-quick-row__copy'>
        <strong>{item.name}</strong>
        <span
          className={`workspace-quick-row__meta ${monoMeta ? 'is-path' : ''}`}
        >
          {meta}
        </span>
      </span>
      {item.current ? (
        <span className='workspace-quick-row__check' aria-label='Current'>
          ✓
        </span>
      ) : item.pending ? (
        <StatusBadge status='importing'>Importing</StatusBadge>
      ) : item.status === 'error' ? (
        <StatusBadge status='error'>Failed</StatusBadge>
      ) : null}
    </button>
  )
}

function WorkspaceMethodRow({ method, disabled, title, onSelect }) {
  const kind =
    method.id === 'clone'
      ? 'git'
      : method.id === 'blank'
        ? 'cloud'
        : method.id === 'ssh'
          ? 'ssh'
          : 'local'

  return (
    <button
      type='button'
      className='workspace-quick-method'
      disabled={disabled}
      title={title}
      onClick={() => onSelect(method.id)}
    >
      <span className='workspace-quick-row__icon' aria-hidden='true'>
        <WorkspaceTypeIcon kind={kind} />
      </span>
      <span className='workspace-quick-row__copy'>
        <strong>{method.label}</strong>
        <span>{method.description}</span>
      </span>
    </button>
  )
}

export default function WorkspaceQuickSwitcher({ open, onClose, onManage }) {
  const capabilitiesLoaded = useCapabilitiesStore(state => state.loaded)
  const manifest = useCapabilitiesStore(state => state.manifest)
  const handle = useWorkspaceContextStore(state => state.handle)
  const label = useWorkspaceContextStore(state => state.label)
  const recentHandles = useWorkspaceContextStore(state => state.recentHandles)
  const selectDesktop = useWorkspaceContextStore(state => state.select)
  const cloudWorkspaces = useCloudWorkspaceStore(state => state.workspaces)
  const cloudCurrentId = useCloudWorkspaceStore(state => state.currentId)
  const cloudPendingId = useCloudWorkspaceStore(state => state.pendingId)
  const cloudLimit = useCloudWorkspaceStore(state => state.limit)
  const cloudLoaded = useCloudWorkspaceStore(state => state.loaded)
  const cloudEnabled = useCloudWorkspaceStore(state => state.enabled)
  const loadCloud = useCloudWorkspaceStore(state => state.load)
  const refreshCloud = useCloudWorkspaceStore(state => state.refresh)
  const selectCloud = useCloudWorkspaceStore(state => state.select)
  const isStreaming = useChatStore(state => state.isStreaming)
  const sessionLoading = useChatStore(state => state.sessionLoading)
  const [createMethodId, setCreateMethodId] = useState(null)
  const [error, setError] = useState(null)
  const cloud = manifest.profile === 'cloud'
  const locked = isWorkspaceProfileLocked(
    manifest.profile,
    authEnabled(),
    isSuperUser(getUser()),
  )
  const chatBusy = isStreaming || sessionLoading

  const methods = useMemo(() => {
    const resolved = resolveWorkspaceCreateMethods(manifest)
    return resolved.filter(method => method.id !== 'ssh' || remoteEnabled())
  }, [manifest])

  const items = useMemo(
    () =>
      cloud
        ? buildCloudWorkspaceItems(
            cloudWorkspaces,
            cloudCurrentId,
            cloudPendingId,
          )
        : buildDesktopWorkspaceItems({ handle, label, recentHandles }).filter(
            item => !locked || item.current,
          ),
    [
      cloud,
      cloudCurrentId,
      cloudPendingId,
      cloudWorkspaces,
      handle,
      label,
      locked,
      recentHandles,
    ],
  )

  useEffect(() => {
    if (!open) return
    setError(null)
    if (!cloud || !capabilitiesLoaded || !manifest.workspace.enabled) return
    const request = cloudLoaded && cloudEnabled ? refreshCloud() : loadCloud()
    void Promise.resolve(request).catch(err => {
      setError(err?.message || 'Could not load workspaces')
    })
  }, [
    capabilitiesLoaded,
    cloud,
    cloudEnabled,
    cloudLoaded,
    loadCloud,
    manifest.workspace.enabled,
    open,
    refreshCloud,
  ])

  const selectWorkspace = item => {
    setError(null)
    if (item.current) {
      onClose()
      return
    }
    const selected = cloud
      ? selectCloud(item.id)
      : selectDesktop(item.handle, {
          label: item.label,
          profile: 'desktop',
        })
    if (selected === true) {
      onClose()
    } else {
      setError('Wait for the current chat before changing workspace.')
    }
  }

  const atLimit =
    cloud && cloudLimit != null && cloudWorkspaces.length >= cloudLimit
  const createDisabled =
    !capabilitiesLoaded ||
    !manifest.workspace.enabled ||
    methods.length === 0 ||
    locked ||
    atLimit
  const createDisabledTitle = atLimit
    ? `Workspace limit of ${cloudLimit} reached`
    : locked
      ? 'This workspace is managed by your administrator'
      : ''

  return (
    <>
      {open && (
        <section
          className='workspace-quick-switcher'
          role='dialog'
          aria-label='Switch workspace'
        >
          <header className='workspace-quick-switcher__head'>
            <div>
              <strong>Workspaces</strong>
              <span>Choose where the next chat runs</span>
            </div>
            <button
              type='button'
              className='workspace-quick-switcher__close'
              aria-label='Close workspace switcher'
              onClick={onClose}
            >
              ×
            </button>
          </header>

          {!capabilitiesLoaded ? (
            <div className='workspace-quick-switcher__state'>
              <span className='spinner' aria-hidden='true' />
              Loading workspaces…
            </div>
          ) : !manifest.workspace.enabled ? (
            <div className='workspace-quick-switcher__state'>
              {manifest.workspace.reason || 'Workspace management is disabled.'}
            </div>
          ) : (
            <>
              {items.length > 1 && (
                <div className='workspace-quick-switcher__label'>Recent</div>
              )}
              <div className='workspace-quick-switcher__list thin-scrollbar'>
                {items.slice(0, 6).map(item => (
                  <WorkspaceRow
                    key={item.id}
                    item={item}
                    cloud={cloud}
                    busy={chatBusy}
                    onSelect={selectWorkspace}
                  />
                ))}
                {items.length === 0 && (
                  <p>Choose an option below to create your first workspace.</p>
                )}
              </div>
              {methods.length > 0 && (
                <>
                  <div className='workspace-quick-switcher__label'>
                    New workspace
                  </div>
                  <div className='workspace-quick-switcher__methods'>
                    {methods.map(method => (
                      <WorkspaceMethodRow
                        key={method.id}
                        method={method}
                        disabled={createDisabled}
                        title={createDisabledTitle}
                        onSelect={methodId => {
                          onClose()
                          setCreateMethodId(methodId)
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
              {createDisabledTitle && (
                <p className='workspace-quick-switcher__hint'>
                  {createDisabledTitle}
                </p>
              )}
            </>
          )}

          {error && (
            <div className='workspace-quick-switcher__error' role='alert'>
              {error}
            </div>
          )}

          <footer className='workspace-quick-switcher__footer'>
            <button
              type='button'
              className='workspace-quick-switcher__manage'
              onClick={() => {
                onClose()
                onManage()
              }}
            >
              Manage workspaces
              <span aria-hidden='true'>›</span>
            </button>
          </footer>
        </section>
      )}

      <WorkspaceCreateDialog
        open={Boolean(createMethodId)}
        onClose={() => setCreateMethodId(null)}
        methods={methods}
        initialMethodId={createMethodId}
        profile={cloud ? 'cloud' : 'desktop'}
        startDir={handle?.environmentId === 'local' ? handle.cwd : '.'}
        onCreated={() => setCreateMethodId(null)}
      />
    </>
  )
}
