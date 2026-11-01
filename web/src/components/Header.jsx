import { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { useWorkspaceIdeStore } from '../stores/workspace-ide-store.js'
import { useWorkspaceContextStore } from '../stores/workspace-context-store.js'
import { useCapabilitiesStore } from '../stores/capabilities-store.js'
import { workspaceApi } from '../lib/api/workspace.js'
import { factoryResetDesktop, isDesktop } from '../lib/desktop.js'
import { authEnabled, getUser, logout } from '../lib/auth.js'
import SessionSwitcher from './SessionSwitcher.jsx'
import BaizeLogo from './BaizeLogo.jsx'
import ExtensionsHub from './extensions/ExtensionsHub.jsx'
import WorkspaceManager from './workspaces/WorkspaceManager.jsx'
import WorkspaceQuickSwitcher from './workspaces/WorkspaceQuickSwitcher.jsx'
import { useCloudWorkspaceStore } from '../stores/cloud-workspace-store.js'
import { APP_NAME } from '../lib/brand.js'
import { shortDisplayPath } from '../lib/utils.js'

export default function Header() {
  const user = authEnabled() ? getUser() : null
  const desktopApp = isDesktop()

  const workspace = useWorkspaceContextStore(s => s.cwd)
  const workspaceLabel = useWorkspaceContextStore(s => s.label)
  const applyWorkspace = useWorkspaceContextStore(s => s.apply)
  const toggleWorkspaceIde = useWorkspaceIdeStore(s => s.toggle)
  const workspaceIdeOpen = useWorkspaceIdeStore(s => s.open)
  const toggleTheme = useChatStore(s => s.toggleTheme)
  const theme = useChatStore(s => s.theme)
  const clearSession = useChatStore(s => s.clearSession)
  const isStreaming = useChatStore(s => s.isStreaming)
  const loadCloudWorkspaces = useCloudWorkspaceStore(s => s.load)
  const capabilitiesLoaded = useCapabilitiesStore(s => s.loaded)
  const runtimeProfile = useCapabilitiesStore(s => s.profile)
  const workspaceCapability = useCapabilitiesStore(s => s.manifest.workspace)
  const extensionSections = useCapabilitiesStore(
    s => s.manifest.extensions.sections,
  )
  const cloudProfile = runtimeProfile === 'cloud'
  const extensionDisabledReasons = [
    ...new Set(
      Object.values(extensionSections)
        .filter(section => !section.enabled && section.reason)
        .map(section => section.reason),
    ),
  ]

  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false)
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false)
  const [extensionsHubOpen, setExtensionsHubOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState(null)
  const accountRef = useRef(null)
  const workspaceMenuRef = useRef(null)

  useEffect(() => {
    if (!capabilitiesLoaded) return
    if (cloudProfile) {
      void loadCloudWorkspaces()
      return
    }
    const applyDefault = cwd => {
      if (useWorkspaceContextStore.getState().handle) return
      applyWorkspace(
        { environmentId: 'local', cwd },
        {
          label: cwd,
          profile: 'desktop',
          invalidateSync: false,
        },
      )
    }
    workspaceApi
      .getRoot()
      .then(data => applyDefault(data.workspace))
      .catch(() => applyDefault('.'))
  }, [applyWorkspace, capabilitiesLoaded, cloudProfile, loadCloudWorkspaces])

  useEffect(() => {
    const handler = e => {
      if (accountRef.current && !accountRef.current.contains(e.target)) {
        setAccountOpen(false)
      }
      if (
        workspaceMenuRef.current &&
        !workspaceMenuRef.current.contains(e.target)
      ) {
        setWorkspaceSwitcherOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  useEffect(() => {
    if (!workspaceSwitcherOpen) return undefined
    const closeOnEscape = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setWorkspaceSwitcherOpen(false)
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [workspaceSwitcherOpen])

  const handleFactoryReset = async () => {
    if (resetConfirmation !== 'RESET' || resetBusy) return
    setResetBusy(true)
    setResetError(null)
    try {
      if (desktopApp) {
        await factoryResetDesktop(resetConfirmation)
        return
      }
      await workspaceApi.reset(resetConfirmation)
      for (const key of Object.keys(localStorage)) {
        if (
          key.startsWith('coding_agent_') &&
          key !== 'coding_agent_auth_token' &&
          key !== 'coding_agent_theme'
        ) {
          localStorage.removeItem(key)
        }
      }
      window.location.reload()
    } catch (err) {
      setResetError(err?.message || 'Factory reset failed')
      setResetBusy(false)
    }
  }

  const folderIcon = (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' />
    </svg>
  )

  const pathLabel =
    shortDisplayPath(workspaceLabel || workspace, 32) ||
    workspaceLabel ||
    workspace ||
    'Select workspace'
  const userLabel =
    user?.username || user?.email || (desktopApp ? 'Desktop app' : '')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'U'

  return (
    <header className='header'>
      <div className='header-left'>
        <button
          className={`icon-btn workspace-toggle ${workspaceIdeOpen ? 'active' : ''}`}
          onClick={toggleWorkspaceIde}
          title={workspaceIdeOpen ? 'Hide workspace' : 'Show workspace'}
        >
          <svg
            width='16'
            height='16'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <rect x='3' y='3' width='18' height='18' rx='2' />
            <path d='M9 3v18' />
          </svg>
        </button>

        <div className='logo'>
          <BaizeLogo size='sm' />
          <span className='logo-text'>{APP_NAME}</span>
        </div>

        <span className='header-sep' aria-hidden='true' />

        <SessionSwitcher />
        <button
          type='button'
          className='icon-btn new-chat-btn'
          onClick={clearSession}
          disabled={isStreaming}
          title='New chat'
          aria-label='New chat'
        >
          <svg
            width='16'
            height='16'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
          >
            <path d='M12 20h9' />
            <path d='M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z' />
          </svg>
        </button>

        <div className='workspace-switcher-anchor' ref={workspaceMenuRef}>
          <button
            type='button'
            className={`workspace-chip workspace-chip--manager ${
              workspaceSwitcherOpen ? 'open' : ''
            }`}
            onClick={() => setWorkspaceSwitcherOpen(value => !value)}
            title={
              workspaceCapability.enabled
                ? workspaceLabel || workspace || 'Switch workspace'
                : workspaceCapability.reason ||
                  'Workspace management unavailable'
            }
            aria-haspopup='dialog'
            aria-expanded={workspaceSwitcherOpen}
          >
            {folderIcon}
            <span className='workspace-chip-path'>{pathLabel}</span>
            <svg
              className='workspace-chip-caret'
              width='12'
              height='12'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeLinejoin='round'
              aria-hidden='true'
            >
              <polyline points='9 6 15 12 9 18' />
            </svg>
          </button>
          <WorkspaceQuickSwitcher
            open={workspaceSwitcherOpen}
            onClose={() => setWorkspaceSwitcherOpen(false)}
            onManage={() => {
              setWorkspaceSwitcherOpen(false)
              setWorkspaceManagerOpen(true)
            }}
          />
        </div>
      </div>

      <div className='header-right'>
        <button
          type='button'
          className='ai-extensions-trigger'
          onClick={() => setExtensionsHubOpen(true)}
          title={
            extensionDisabledReasons.length > 0
              ? `Manage AI extensions · ${extensionDisabledReasons.join(' ')}`
              : 'Manage AI extensions'
          }
        >
          <svg
            width='15'
            height='15'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.9'
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
          >
            <rect x='3' y='3' width='7' height='7' rx='2' />
            <rect x='14' y='3' width='7' height='7' rx='2' />
            <rect x='3' y='14' width='7' height='7' rx='2' />
            <path d='M17.5 14v7M14 17.5h7' />
          </svg>
          <span>AI Extensions</span>
        </button>
        <button className='icon-btn' onClick={toggleTheme} title='Toggle theme'>
          {theme === 'dark' ? (
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <circle cx='12' cy='12' r='5' />
              <line x1='12' y1='1' x2='12' y2='3' />
              <line x1='12' y1='21' x2='12' y2='23' />
              <line x1='4.22' y1='4.22' x2='5.64' y2='5.64' />
              <line x1='18.36' y1='18.36' x2='19.78' y2='19.78' />
              <line x1='1' y1='12' x2='3' y2='12' />
              <line x1='21' y1='12' x2='23' y2='12' />
              <line x1='4.22' y1='19.78' x2='5.64' y2='18.36' />
              <line x1='18.36' y1='5.64' x2='19.78' y2='4.22' />
            </svg>
          ) : (
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' />
            </svg>
          )}
        </button>
        {(user || desktopApp) && (
          <>
            <span className='header-action-sep' aria-hidden='true' />
            <div className='account-menu' ref={accountRef}>
              <button
                type='button'
                className={`account-trigger ${accountOpen ? 'open' : ''}`}
                onClick={e => {
                  e.stopPropagation()
                  setAccountOpen(v => !v)
                }}
                title={user?.email || 'Desktop app'}
                aria-haspopup='menu'
                aria-expanded={accountOpen}
              >
                <span className='account-avatar' aria-hidden='true'>
                  {userInitial}
                </span>
                <span className='account-name'>{userLabel}</span>
                <svg
                  className='account-caret'
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  aria-hidden='true'
                >
                  <polyline points='6 9 12 15 18 9' />
                </svg>
              </button>
              {accountOpen && (
                <div className='account-dropdown' role='menu'>
                  <div className='account-dropdown-identity'>
                    <span className='account-dropdown-name'>{userLabel}</span>
                    {user?.email && user.email !== userLabel && (
                      <span className='account-dropdown-email'>
                        {user.email}
                      </span>
                    )}
                  </div>
                  <button
                    type='button'
                    className='account-reset'
                    onClick={() => {
                      setAccountOpen(false)
                      setResetConfirmation('')
                      setResetError(null)
                      setResetOpen(true)
                    }}
                    role='menuitem'
                  >
                    Restore initial state
                  </button>
                  {user && (
                    <button
                      type='button'
                      className='account-signout'
                      onClick={logout}
                      role='menuitem'
                    >
                      <svg
                        width='14'
                        height='14'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        aria-hidden='true'
                      >
                        <path d='M10 17l5-5-5-5' />
                        <path d='M15 12H3' />
                        <path d='M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' />
                      </svg>
                      Sign out
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <WorkspaceManager
        open={workspaceManagerOpen}
        onClose={() => setWorkspaceManagerOpen(false)}
        onAddWorkspace={() => {
          setWorkspaceManagerOpen(false)
          requestAnimationFrame(() => setWorkspaceSwitcherOpen(true))
        }}
      />
      <ExtensionsHub
        open={extensionsHubOpen}
        onClose={() => setExtensionsHubOpen(false)}
      />
      {resetOpen && (
        <div
          className='factory-reset-backdrop'
          role='presentation'
          onMouseDown={e => {
            if (e.target === e.currentTarget && !resetBusy) setResetOpen(false)
          }}
        >
          <div
            className='factory-reset-dialog'
            role='dialog'
            aria-modal='true'
            aria-labelledby='factory-reset-title'
          >
            <h2 id='factory-reset-title'>Restore initial state</h2>
            <p>
              This permanently deletes files, chats, memories, scheduled tasks,
              browser data, custom agents and skills
              {cloudProfile ? ', and every workspace with its repository' : ''}
              {desktopApp ? ', and all saved API keys' : ''}.
            </p>
            {desktopApp && (
              <p className='factory-reset-note'>
                Project folders outside the application data directory will
                remain unchanged. The app will restart when reset is complete.
              </p>
            )}
            <label htmlFor='factory-reset-confirmation'>
              Type <strong>RESET</strong> to continue
            </label>
            <input
              id='factory-reset-confirmation'
              autoFocus
              value={resetConfirmation}
              disabled={resetBusy}
              onChange={e => setResetConfirmation(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleFactoryReset()
                if (e.key === 'Escape' && !resetBusy) setResetOpen(false)
              }}
            />
            {resetError && (
              <div className='factory-reset-error' role='alert'>
                {resetError}
              </div>
            )}
            <div className='factory-reset-actions'>
              <button
                type='button'
                disabled={resetBusy}
                onClick={() => setResetOpen(false)}
              >
                Cancel
              </button>
              <button
                type='button'
                className='factory-reset-confirm'
                disabled={resetConfirmation !== 'RESET' || resetBusy}
                onClick={() => void handleFactoryReset()}
              >
                {resetBusy ? 'Restoring…' : 'Delete data and restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
