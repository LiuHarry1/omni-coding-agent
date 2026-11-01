import { useCallback, useEffect, useState } from 'react'
import { environmentsApi } from '../lib/api/environments.js'
import { useChatStore } from '../stores/chat-store.js'
import {
  sameWorkspaceHandle,
  useWorkspaceContextStore,
} from '../stores/workspace-context-store.js'

/**
 * VS Code–style environment picker: list local + SSH hosts, connect, pick folder.
 */
export default function EnvironmentPicker({ onBound, allowedKinds }) {
  const [envs, setEnvs] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [browse, setBrowse] = useState(null) // { environmentId, dir, entries }
  const [manualHost, setManualHost] = useState('')
  const workspaceLabel = useWorkspaceContextStore(s => s.label)
  const selectWorkspace = useWorkspaceContextStore(s => s.select)

  const loadEnvs = useCallback(async () => {
    setError(null)
    try {
      const data = await environmentsApi.list()
      setEnvs(data.environments || [])
    } catch (err) {
      setError(err.message || 'Failed to list environments')
    }
  }, [])

  useEffect(() => {
    void loadEnvs()
  }, [loadEnvs])

  const allowedKindSet = allowedKinds?.length ? new Set(allowedKinds) : null
  const visibleEnvs = allowedKindSet
    ? envs.filter(env => allowedKindSet.has(env.kind))
    : envs

  const connectAndBrowse = async env => {
    setBusy(true)
    setError(null)
    try {
      if (allowedKindSet && !allowedKindSet.has(env.kind)) {
        throw new Error(
          `The ${env.kind} environment type is not available here`,
        )
      }
      await environmentsApi.connect(env.id, env.defaultCwd)
      const data = await environmentsApi.listDir(env.id, env.defaultCwd)
      setBrowse({
        environmentId: env.id,
        displayName: env.displayName,
        dir: data.dir,
        entries: data.entries || [],
      })
    } catch (err) {
      setError(err.message || 'Connect failed')
    } finally {
      setBusy(false)
    }
  }

  const enterDir = async entry => {
    if (!browse || entry.type !== 'dir') return
    setBusy(true)
    setError(null)
    try {
      const data = await environmentsApi.listDir(
        browse.environmentId,
        entry.path,
      )
      setBrowse({
        ...browse,
        dir: data.dir,
        entries: data.entries || [],
      })
    } catch (err) {
      setError(err.message || 'List failed')
    } finally {
      setBusy(false)
    }
  }

  const bindCurrentDir = async () => {
    if (!browse) return
    setBusy(true)
    setError(null)
    try {
      let handle = {
        environmentId: browse.environmentId,
        cwd: browse.dir,
      }
      let label = `${browse.displayName}:${browse.dir}`
      const context = useWorkspaceContextStore.getState()
      const chat = useChatStore.getState()
      const switching = !sameWorkspaceHandle(context.handle, handle)
      if (switching && (chat.isStreaming || chat.sessionLoading)) {
        throw new Error('Wait for the current chat before changing workspace')
      }

      // A transcript must stay on its server-bound workspace. Selecting a
      // different one first starts a new chat; an empty Session can be rebound.
      if (switching && chat.bubbleOrder.length > 0) {
        if (
          !selectWorkspace(handle, {
            label,
            profile: 'desktop',
          })
        ) {
          throw new Error('Could not change workspace')
        }
      } else if (chat.currentSessionId) {
        const res = await environmentsApi.bindSessionWorkspace(
          chat.currentSessionId,
          handle,
        )
        handle = res.workspace || handle
        label = res.label || label
        if (
          !selectWorkspace(handle, {
            label,
            profile: 'desktop',
          })
        ) {
          throw new Error('Could not change workspace')
        }
      } else if (
        !selectWorkspace(handle, {
          label,
          profile: 'desktop',
        })
      ) {
        throw new Error('Could not change workspace')
      }
      onBound?.(handle, label)
    } catch (err) {
      setError(err.message || 'Bind failed')
    } finally {
      setBusy(false)
    }
  }

  const connectManual = async () => {
    const input = manualHost.trim()
    if (!input) return
    setBusy(true)
    setError(null)
    try {
      const env = await environmentsApi.resolve(input)
      if (allowedKindSet && !allowedKindSet.has(env.kind)) {
        throw new Error(`Expected an ${[...allowedKindSet].join(' or ')} host`)
      }
      await connectAndBrowse(env)
    } catch (err) {
      setError(err.message || 'Resolve failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='env-picker-embedded'>
      <div className='env-picker-panel'>
        <div className='env-picker-dropdown-header'>
          {browse
            ? `Open Folder — ${browse.displayName}`
            : 'Select environment'}
        </div>
        {error && <div className='env-picker-error'>{error}</div>}
        {busy && <div className='env-picker-busy'>Working…</div>}
        {!browse ? (
          <>
            <div className='env-picker-list'>
              {visibleEnvs.map(env => (
                <button
                  key={env.id}
                  type='button'
                  className='env-picker-item'
                  onClick={() => connectAndBrowse(env)}
                >
                  <span className='env-picker-kind'>{env.kind}</span>
                  <span className='env-picker-name'>{env.displayName}</span>
                </button>
              ))}
              {visibleEnvs.length === 0 && !busy && (
                <div className='env-picker-busy'>No environments found</div>
              )}
            </div>
            {(!allowedKindSet || allowedKindSet.has('ssh')) && (
              <div className='env-picker-manual'>
                <input
                  className='env-picker-input'
                  placeholder='user@host or Host alias'
                  value={manualHost}
                  onChange={e => setManualHost(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') connectManual()
                  }}
                />
                <button
                  type='button'
                  className='env-picker-go'
                  onClick={connectManual}
                >
                  Go
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className='env-picker-path'>{browse.dir}</div>
            <div className='env-picker-list'>
              {browse.entries
                .filter(e => e.type === 'dir')
                .map(entry => (
                  <button
                    key={entry.path}
                    type='button'
                    className='env-picker-item'
                    onClick={() => enterDir(entry)}
                  >
                    <span className='env-picker-name'>{entry.name}/</span>
                  </button>
                ))}
            </div>
            <div className='env-picker-actions'>
              <button
                type='button'
                className='env-picker-go'
                onClick={() => setBrowse(null)}
              >
                Back
              </button>
              <button
                type='button'
                className='env-picker-go env-picker-go--primary'
                onClick={bindCurrentDir}
              >
                Open this folder
              </button>
            </div>
          </>
        )}
        {workspaceLabel && (
          <div className='env-picker-current'>Current: {workspaceLabel}</div>
        )}
      </div>
    </div>
  )
}
