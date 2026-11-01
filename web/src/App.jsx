import { useEffect } from 'react'
import { useChatStore } from './stores/chat-store.js'
import { useWorkspaceIdeStore } from './stores/workspace-ide-store.js'
import { useWorkspaceContextStore } from './stores/workspace-context-store.js'
import { useCapabilitiesStore } from './stores/capabilities-store.js'
import { agentApi } from './lib/api/agent.js'
import { setKnownMcpServers } from './lib/tool-kind.js'
import { ChatActionsProvider } from './lib/chat-actions.jsx'
import Header from './components/Header.jsx'
import BrowserLockBar from './components/BrowserLockBar.jsx'
import ChatView from './components/ChatView.jsx'
import BackgroundTerminals from './components/BackgroundTerminals.jsx'
import InputArea from './components/InputArea.jsx'
import WorkspaceIDE from './components/workspace-ide/index.js'

export default function App() {
  const theme = useChatStore(s => s.theme)
  const syncHljs = useChatStore(s => s.syncHljs)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const liveNeeded = useChatStore(s => s.liveNeeded)
  const switchSession = useChatStore(s => s.switchSession)
  const connectSessionLive = useChatStore(s => s.connectSessionLive)
  const workspace = useWorkspaceContextStore(s => s.cwd)
  const workspaceEnvId = useWorkspaceContextStore(
    s => s.handle?.environmentId || 'local',
  )
  const workspaceIdeOpen = useWorkspaceIdeStore(s => s.open)
  const setIdeRootPath = useWorkspaceIdeStore(s => s.setRootPath)
  const loadCapabilities = useCapabilitiesStore(s => s.load)
  const reloadCapabilities = useCapabilitiesStore(s => s.reload)
  const capabilitiesStatus = useCapabilitiesStore(s => s.status)
  const capabilitiesError = useCapabilitiesStore(s => s.error)
  const capabilitiesReady =
    capabilitiesStatus === 'ready' || capabilitiesStatus === 'legacy'

  useEffect(() => {
    void loadCapabilities()
  }, [loadCapabilities])

  useEffect(() => {
    syncHljs()
  }, [theme])

  useEffect(() => {
    if (capabilitiesReady && currentSessionId) switchSession(currentSessionId)
  }, [capabilitiesReady, currentSessionId, switchSession])

  useEffect(() => {
    if (!capabilitiesReady || !currentSessionId || !liveNeeded) return
    return connectSessionLive(currentSessionId)
  }, [capabilitiesReady, currentSessionId, liveNeeded, connectSessionLive])

  // Bridge: workspace context owns cwd + environment; IDE stores both so FS
  // calls can route local vs remote without importing the context store.
  useEffect(() => {
    setIdeRootPath(workspace, {
      resetTree: true,
      environmentId: workspaceEnvId,
    })
  }, [workspace, workspaceEnvId, setIdeRootPath])

  // Cache MCP server names for accurate `server/tool` labels in chat rows.
  useEffect(() => {
    if (!capabilitiesReady) return
    let cancelled = false
    agentApi
      .getMcp(workspace || undefined)
      .then(data => {
        if (cancelled) return
        const names = (data?.servers ?? []).map(s => s.name).filter(Boolean)
        setKnownMcpServers(names)
      })
      .catch(() => {
        if (!cancelled) setKnownMcpServers([])
      })
    return () => {
      cancelled = true
    }
  }, [capabilitiesReady, workspace])

  // Warn before unload if any open file has unsaved edits. Reads the
  // store imperatively (no re-render needed for this side-effect-only listener).
  useEffect(() => {
    const handler = e => {
      const { fileContents } = useWorkspaceIdeStore.getState()
      const hasDirty = Object.values(fileContents).some(f => f && f.dirty)
      if (hasDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  if (!capabilitiesReady) {
    const failed = capabilitiesStatus === 'unavailable'
    return (
      <div className={`app ${theme}`} data-theme={theme}>
        <main className='capabilities-gate' aria-live='polite'>
          {failed ? (
            <>
              <span className='capabilities-gate__mark' aria-hidden='true'>
                !
              </span>
              <h1>Couldn&apos;t connect to the agent</h1>
              <p>
                Server capabilities could not be loaded. Workspace and extension
                actions are paused to avoid using the wrong runtime.
              </p>
              {capabilitiesError && (
                <code className='capabilities-gate__error'>
                  {capabilitiesError}
                </code>
              )}
              <button
                type='button'
                className='capabilities-gate__button'
                onClick={() => void reloadCapabilities()}
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <span className='spinner' aria-hidden='true' />
              <p>Loading agent capabilities…</p>
            </>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className={`app ${theme}`} data-theme={theme}>
      <WorkspaceIDE />
      <div className={`main-panel ${workspaceIdeOpen ? 'with-ide' : ''}`}>
        <Header />
        <BrowserLockBar />
        <ChatActionsProvider>
          <ChatView />
          <BackgroundTerminals />
          <InputArea />
        </ChatActionsProvider>
      </div>
    </div>
  )
}
