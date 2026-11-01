import { useCallback, useEffect, useState } from 'react'
import { agentApi } from '../../lib/api/agent.js'
import StatusBadge from './StatusBadge.jsx'

function StatusSectionShell({
  title,
  description,
  loading,
  error,
  count,
  onRefresh,
  children,
}) {
  return (
    <div className='extensions-section extensions-status-section'>
      <div className='extensions-section__toolbar'>
        <div>
          <h2>{title}</h2>
          <p>
            {description}
            {count != null ? ` · ${count} configured` : ''}
          </p>
        </div>
        <button
          type='button'
          className='extensions-button'
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && (
        <div className='extensions-alert extensions-alert--error' role='alert'>
          {error}
        </div>
      )}
      {children}
    </div>
  )
}

export function PluginsSection({ workspace, refreshToken = 0 }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await agentApi.getPlugins(workspace))
    } catch (err) {
      setError(err?.message || 'Could not load plugins')
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const plugins = data?.plugins || []

  return (
    <StatusSectionShell
      title='Plugins'
      description='Installed extension bundles and their contributions'
      loading={loading}
      error={error}
      count={plugins.length}
      onRefresh={() => void load()}
    >
      {!loading && plugins.length === 0 ? (
        <div className='extensions-blank-state'>
          <span className='extensions-blank-state__mark'>⌁</span>
          <h3>No plugins installed</h3>
          <p>Install trusted resources from Marketplace to see them here.</p>
        </div>
      ) : (
        <div className='extensions-status-grid'>
          {plugins.map(plugin => (
            <article key={plugin.name} className='extensions-status-card'>
              <div className='extensions-status-card__head'>
                <div>
                  <h3>{plugin.name}</h3>
                  {plugin.description && <p>{plugin.description}</p>}
                </div>
                <StatusBadge status='installed'>Installed</StatusBadge>
              </div>
              <div className='extensions-status-card__meta'>
                <span>{plugin.scope || 'user'} scope</span>
                {plugin.version && <span>v{plugin.version}</span>}
              </div>
              <dl className='extensions-contribution-grid'>
                <div>
                  <dt>Agents</dt>
                  <dd>{plugin.agents ?? 0}</dd>
                </div>
                <div>
                  <dt>Skills</dt>
                  <dd>{plugin.skills ?? 0}</dd>
                </div>
                <div>
                  <dt>Commands</dt>
                  <dd>{plugin.commands ?? 0}</dd>
                </div>
                <div>
                  <dt>MCP</dt>
                  <dd>{plugin.mcp ?? 0}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </StatusSectionShell>
  )
}

export function LspSection({ workspace, workspaceHandle, refreshToken = 0 }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await agentApi.getLsp(workspaceHandle || workspace))
    } catch (err) {
      setError(err?.message || 'Could not load language servers')
    } finally {
      setLoading(false)
    }
  }, [workspace, workspaceHandle])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const servers = data?.servers || []
  const running = servers.filter(server => server.state === 'running').length

  return (
    <StatusSectionShell
      title='Language servers'
      description={`${running} running · Servers start when matching files are used`}
      loading={loading}
      error={error}
      count={servers.length}
      onRefresh={() => void load()}
    >
      {!loading && servers.length === 0 ? (
        <div className='extensions-blank-state'>
          <span className='extensions-blank-state__mark'>&lt;/&gt;</span>
          <h3>No language servers configured</h3>
          <p>
            Language servers are managed by your runtime environment
            configuration.
          </p>
        </div>
      ) : (
        <div className='extensions-status-grid'>
          {servers.map(server => {
            const command = [server.command, ...(server.args || [])]
              .filter(Boolean)
              .join(' ')
            return (
              <article key={server.name} className='extensions-status-card'>
                <div className='extensions-status-card__head'>
                  <div>
                    <h3>{server.name}</h3>
                    {command && <code title={command}>{command}</code>}
                  </div>
                  <StatusBadge
                    status={server.state || 'stopped'}
                    title={server.error}
                  >
                    {server.state || 'stopped'}
                  </StatusBadge>
                </div>
                {(server.languages?.length > 0 ||
                  server.extensions?.length > 0) && (
                  <div className='extensions-token-list'>
                    {(server.languages || []).map(language => (
                      <span key={`language:${language}`}>{language}</span>
                    ))}
                    {(server.extensions || []).map(extension => (
                      <span key={`extension:${extension}`}>{extension}</span>
                    ))}
                  </div>
                )}
                {server.error && (
                  <div className='extensions-alert extensions-alert--error'>
                    {server.error}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </StatusSectionShell>
  )
}
