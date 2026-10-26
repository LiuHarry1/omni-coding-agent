import { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { useWorkspaceIdeStore } from '../stores/workspace-ide-store.js'
import { workspaceApi } from '../lib/api/workspace.js'
import {
  factoryResetDesktop,
  isDesktop,
  pickWorkspaceDir,
} from '../lib/desktop.js'
import {
  authEnabled,
  getUser,
  isSuperUser,
  logout,
  remoteEnabled,
} from '../lib/auth.js'
import SessionSwitcher from './SessionSwitcher.jsx'
import BaizeLogo from './BaizeLogo.jsx'
import WorkspacePanel from './WorkspacePanel.jsx'
import MarketplacePanel from './MarketplacePanel.jsx'
import EnvironmentPicker from './EnvironmentPicker.jsx'
import { APP_NAME } from '../lib/brand.js'
import { shortDisplayPath } from '../lib/utils.js'

export default function Header() {
  // SSO mode: regular users are pinned server-side, so the folder picker is
  // read-only. Super may browse USERS_ROOT (all tenant workspaces).
  const locked = authEnabled() && !isSuperUser()
  const showRemote = remoteEnabled()
  const user = authEnabled() ? getUser() : null
  const desktopApp = isDesktop()

  const workspace = useChatStore(s => s.workspace)
  const setWorkspace = useChatStore(s => s.setWorkspace)
  const toggleWorkspaceIde = useWorkspaceIdeStore(s => s.toggle)
  const workspaceIdeOpen = useWorkspaceIdeStore(s => s.open)
  const toggleTheme = useChatStore(s => s.toggleTheme)
  const theme = useChatStore(s => s.theme)
  const clearSession = useChatStore(s => s.clearSession)
  const isStreaming = useChatStore(s => s.isStreaming)

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dropdownData, setDropdownData] = useState(null)
  /** When non-null, the dropdown renders an inline "new folder" input row. */
  const [newFolderName, setNewFolderName] = useState(null)
  const [newFolderError, setNewFolderError] = useState(null)
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false)
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState(null)
  const dropdownRef = useRef(null)
  const accountRef = useRef(null)

  useEffect(() => {
    workspaceApi
      .getRoot()
      .then(d => setWorkspace(d.workspace))
      .catch(() => setWorkspace('.'))
  }, [setWorkspace])

  useEffect(() => {
    const handler = e => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
      if (accountRef.current && !accountRef.current.contains(e.target)) {
        setAccountOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const loadDirectory = useCallback(
    async dir => {
      try {
        const data = await workspaceApi.listDir(dir)
        setDropdownData(data)
        setWorkspace(data.dir)
        setDropdownOpen(true)
        setNewFolderName(null)
        setNewFolderError(null)
      } catch {
        setDropdownData(null)
      }
    },
    [setWorkspace],
  )

  const handleCreateFolder = async () => {
    const name = (newFolderName || '').trim()
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      setNewFolderError('Invalid name')
      return
    }
    const target = `${dropdownData.dir.replace(/\/$/, '')}/${name}`
    try {
      await workspaceApi.createFolder(target)
      // Reload the current dir so the new folder shows up, then auto-pick it.
      await loadDirectory(dropdownData.dir)
      setWorkspace(target)
      setDropdownOpen(false)
    } catch (err) {
      setNewFolderError(err.message || 'Create failed')
    }
  }

  const handleBrowse = e => {
    e.stopPropagation()
    if (dropdownOpen) setDropdownOpen(false)
    else loadDirectory(workspace || '.')
  }

  const handlePickFolder = async e => {
    e.stopPropagation()
    setDropdownOpen(false)
    const dir = await pickWorkspaceDir()
    if (dir) setWorkspace(dir)
  }

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

  const selectDir = dir => {
    setWorkspace(dir)
    setDropdownOpen(false)
    setNewFolderName(null)
    setNewFolderError(null)
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
    shortDisplayPath(workspace, 32) || workspace || 'Select workspace'
  const userLabel =
    user?.username || user?.email || (desktopApp ? 'Desktop app' : '')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'U'

  const dirs = dropdownData?.entries?.filter(e => e.isDir) || []

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
            <path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' />
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

        {!workspaceIdeOpen &&
          (locked ? (
            <div
              className='workspace-chip workspace-chip--readonly'
              title={workspace}
            >
              {folderIcon}
              <span className='workspace-chip-path'>{pathLabel}</span>
            </div>
          ) : (
            <div
              className={`workspace-bar ${dropdownOpen ? 'open' : ''}`}
              ref={dropdownRef}
            >
              <button
                type='button'
                className={`workspace-chip ${dropdownOpen ? 'open' : ''}`}
                onClick={handleBrowse}
                title={workspace || 'Choose workspace'}
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
                  <polyline points='6 9 12 15 18 9' />
                </svg>
              </button>

              {isDesktop() && (
                <button
                  type='button'
                  className='icon-btn workspace-pick-btn'
                  onClick={handlePickFolder}
                  title='Choose folder'
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
                  >
                    <path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' />
                    <line x1='12' y1='11' x2='12' y2='17' />
                    <line x1='9' y1='14' x2='15' y2='14' />
                  </svg>
                </button>
              )}

              {dropdownOpen && dropdownData && (
                <div className='workspace-dropdown open'>
                  <div className='ws-dropdown-toolbar'>
                    {dropdownData.parent !== dropdownData.dir && (
                      <button
                        type='button'
                        className='ws-parent-btn'
                        onClick={e => {
                          e.stopPropagation()
                          loadDirectory(dropdownData.parent)
                        }}
                        title='Parent folder'
                      >
                        ..
                      </button>
                    )}
                    <span className='ws-path' title={dropdownData.dir}>
                      {dropdownData.dir}
                    </span>
                    <button
                      type='button'
                      className='ws-open-btn'
                      onClick={e => {
                        e.stopPropagation()
                        selectDir(dropdownData.dir)
                      }}
                      title='Use this folder as workspace'
                    >
                      Open
                    </button>
                  </div>

                  <div className='ws-dropdown-actions'>
                    <button
                      type='button'
                      className='ws-new-folder-btn'
                      onClick={e => {
                        e.stopPropagation()
                        setNewFolderName('')
                        setNewFolderError(null)
                      }}
                    >
                      + New folder
                    </button>
                  </div>

                  {newFolderName !== null && (
                    <div
                      className={`ws-entry ws-entry--new ${newFolderError ? 'ws-entry--error' : ''}`}
                    >
                      <span className='ws-entry-icon'>{folderIcon}</span>
                      <input
                        autoFocus
                        className='ws-new-folder-input'
                        value={newFolderName}
                        placeholder='Folder name'
                        onChange={e => {
                          setNewFolderName(e.target.value)
                          setNewFolderError(null)
                        }}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleCreateFolder()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setNewFolderName(null)
                            setNewFolderError(null)
                          }
                        }}
                      />
                      {newFolderError && (
                        <span
                          className='ws-new-folder-error'
                          title={newFolderError}
                        >
                          {newFolderError}
                        </span>
                      )}
                    </div>
                  )}

                  <div className='ws-dropdown-list'>
                    {dirs.length === 0 && newFolderName === null ? (
                      <div className='ws-empty'>No subfolders</div>
                    ) : (
                      dirs.map(entry => (
                        <button
                          type='button'
                          className='ws-entry'
                          key={entry.path}
                          onClick={() => loadDirectory(entry.path)}
                          onDoubleClick={e => {
                            e.preventDefault()
                            selectDir(entry.path)
                          }}
                          title='Open folder · double-click to use as workspace'
                        >
                          <span className='ws-entry-icon'>{folderIcon}</span>
                          <span className='ws-entry-name'>{entry.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

        {showRemote && !workspaceIdeOpen && <EnvironmentPicker />}
      </div>

      <div className='header-right'>
        <button
          type='button'
          className='marketplace-trigger'
          onClick={() => setMarketplaceOpen(true)}
          title='Browse skills and agents'
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
            <path d='M3 9l1.5-5h15L21 9' />
            <path d='M5 13v7h14v-7' />
            <path d='M9 20v-6h6v6' />
            <path d='M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0' />
          </svg>
          <span>Marketplace</span>
        </button>
        <button
          className='icon-btn'
          onClick={() => setWorkspacePanelOpen(true)}
          title='Workspace extensions (agents, skills, plugins)'
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
            <path d='M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z' />
            <circle cx='8.5' cy='14.5' r='1.5' />
            <circle cx='15.5' cy='14.5' r='1.5' />
          </svg>
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
      <WorkspacePanel
        open={workspacePanelOpen}
        workspace={workspace}
        onClose={() => setWorkspacePanelOpen(false)}
      />
      <MarketplacePanel
        open={marketplaceOpen}
        workspace={workspace}
        onClose={() => setMarketplaceOpen(false)}
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
