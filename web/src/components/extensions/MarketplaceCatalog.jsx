import { useCallback, useEffect, useState } from 'react'
import { agentApi } from '../../lib/api/agent.js'

const MARKETPLACE_STATE_LABELS = {
  available: 'Available',
  installed: 'Installed',
  updateAvailable: 'Update available',
  conflict: 'Local conflict',
}

function targetAwareCopy(message, targetLabel) {
  return String(message)
    .replace(/\bworkspace file\(s\)/gi, `${targetLabel} target file(s)`)
    .replace(/\bworkspace files\b/gi, `${targetLabel} target files`)
    .replace(/\bworkspace path\b/gi, `${targetLabel} target path`)
    .replace(/\bthe workspace\b/gi, `the ${targetLabel} target`)
}

export default function MarketplaceCatalog({
  target,
  targetLabel = target?.scope === 'workspace' ? 'Workspace' : 'User',
  onInstalled,
}) {
  const [providers, setProviders] = useState([])
  const [providerId, setProviderId] = useState('')
  const [kind, setKind] = useState('skill')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [installing, setInstalling] = useState(null)
  const [uninstalling, setUninstalling] = useState(null)
  const [previewing, setPreviewing] = useState(null)
  const [bundlePreview, setBundlePreview] = useState(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const provider = providers.find(item => item.id === providerId)
  const needsLogin =
    Boolean(provider) &&
    provider.auth !== 'none' &&
    provider.authenticated !== true

  const refreshProviders = useCallback(async () => {
    const response = await agentApi.getMarketplaceProviders(target)
    const next = response.providers ?? []
    setProviders(next)
    setProviderId(current =>
      next.some(item => item.id === current) ? current : next[0]?.id || '',
    )
    return next
  }, [target])

  useEffect(() => {
    setLoading(true)
    setError(null)
    setCatalog(null)
    setBundlePreview(null)
    setPage(1)
    refreshProviders()
      .catch(err =>
        setError(err.message || 'Failed to load marketplace providers'),
      )
      .finally(() => setLoading(false))
  }, [refreshProviders])

  useEffect(() => {
    if (!provider) return
    const capability =
      kind === 'skill' ? 'skills' : kind === 'agent' ? 'agents' : 'bundles'
    if (provider.capabilities.includes(capability)) return
    setKind(
      provider.capabilities.includes('skills')
        ? 'skill'
        : provider.capabilities.includes('agents')
          ? 'agent'
          : 'bundle',
    )
  }, [kind, provider])

  const loadCatalog = useCallback(async () => {
    if (!providerId || needsLogin) {
      setCatalog(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await agentApi.getMarketplaceCatalog(providerId, {
        kind,
        q: submittedQuery,
        page,
        perPage: 12,
        target,
      })
      setCatalog(response)
    } catch (err) {
      setError(err.message || 'Failed to load marketplace')
      setCatalog(null)
    } finally {
      setLoading(false)
    }
  }, [kind, needsLogin, page, providerId, submittedQuery, target])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const login = async event => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await agentApi.marketplaceLogin(
        providerId,
        { username, password },
        target,
      )
      setPassword('')
      await refreshProviders()
    } catch (err) {
      setError(err.message || 'Marketplace login failed')
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    setLoading(true)
    setError(null)
    try {
      await agentApi.marketplaceLogout(providerId, target)
      await refreshProviders()
      setCatalog(null)
    } catch (err) {
      setError(err.message || 'Marketplace logout failed')
    } finally {
      setLoading(false)
    }
  }

  const install = async (item, options = {}) => {
    setInstalling(item.externalId)
    setError(null)
    try {
      if (item.kind === 'skill') {
        const environment = await agentApi
          .getMarketplaceEnvSchema(providerId, item.externalId, target)
          .catch(() => ({ variables: [] }))
        if (environment.variables?.length) {
          const names = environment.variables
            .map(variable => variable.name || variable.key)
            .filter(Boolean)
          const proceed = window.confirm(
            `This skill expects environment variables${
              names.length ? `: ${names.join(', ')}` : ''
            }. Install it to the ${targetLabel} target without storing secrets?`,
          )
          if (!proceed) return
        }
      }
      await agentApi.installMarketplaceItem(providerId, item, target, options)
      if (item.kind === 'bundle') setBundlePreview(null)
      await Promise.all([loadCatalog(), onInstalled?.()])
    } catch (err) {
      setError(
        targetAwareCopy(
          err.message || 'Marketplace install failed',
          targetLabel,
        ),
      )
    } finally {
      setInstalling(null)
    }
  }

  const previewBundle = async item => {
    setPreviewing(item.externalId)
    setError(null)
    try {
      const response = await agentApi.previewMarketplaceBundle(
        providerId,
        item,
        target,
      )
      setBundlePreview({ item, ...response.preview })
    } catch (err) {
      setError(
        targetAwareCopy(err.message || 'AI Bundle preview failed', targetLabel),
      )
    } finally {
      setPreviewing(null)
    }
  }

  const installBundle = () => {
    if (bundlePreview.requiresConfirmation) {
      const conflicts = bundlePreview.files.filter(
        file => file.state === 'conflict' || file.state === 'modified',
      ).length
      const confirmed = window.confirm(
        `${conflicts} existing ${targetLabel} target file(s) will be replaced with the BaiX versions from this bundle. The current files will be backed up and restored if you uninstall the bundle. Continue?`,
      )
      if (!confirmed) return
    }
    void install(bundlePreview.item, {
      confirmConflicts: bundlePreview.requiresConfirmation,
    })
  }

  const uninstall = async item => {
    const confirmed = window.confirm(
      `Uninstall ${item.kind} "${item.name}" from the ${targetLabel} target?`,
    )
    if (!confirmed) return
    setUninstalling(item.externalId)
    setError(null)
    try {
      await agentApi.uninstallMarketplaceItem(providerId, item, target)
      await Promise.all([loadCatalog(), onInstalled?.()])
    } catch (err) {
      setError(
        targetAwareCopy(
          err.message || 'Marketplace uninstall failed',
          targetLabel,
        ),
      )
    } finally {
      setUninstalling(null)
    }
  }

  if (!loading && providers.length === 0) {
    return (
      <div className='extensions-blank-state extensions-blank-state--compact'>
        <span className='extensions-blank-state__mark'>◇</span>
        <h3>No Marketplace sources configured</h3>
        <p>Add a trusted provider in managed settings to browse resources.</p>
      </div>
    )
  }

  return (
    <div className='ws-marketplace'>
      <div className='ws-marketplace-toolbar'>
        <label>
          <span>Source</span>
          <select
            value={providerId}
            onChange={event => {
              setProviderId(event.target.value)
              setPage(1)
            }}
          >
            {providers.map(item => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div
          className='ws-marketplace-kinds'
          role='group'
          aria-label='Resource type'
        >
          {provider?.capabilities.includes('skills') && (
            <button
              type='button'
              className={kind === 'skill' ? 'is-active' : ''}
              onClick={() => {
                setKind('skill')
                setPage(1)
              }}
            >
              Skills
            </button>
          )}
          {provider?.capabilities.includes('agents') && (
            <button
              type='button'
              className={kind === 'agent' ? 'is-active' : ''}
              onClick={() => {
                setKind('agent')
                setPage(1)
              }}
            >
              Agents
            </button>
          )}
          {provider?.capabilities.includes('bundles') && (
            <button
              type='button'
              className={kind === 'bundle' ? 'is-active' : ''}
              onClick={() => {
                setKind('bundle')
                setPage(1)
              }}
            >
              AI Bundles
            </button>
          )}
        </div>
        {provider?.authenticated && provider.auth !== 'none' && (
          <button
            type='button'
            className='ws-text-btn is-danger'
            onClick={() => void logout()}
          >
            Sign out
          </button>
        )}
      </div>

      {error && <div className='ws-panel-error'>{error}</div>}

      {needsLogin ? (
        <form className='ws-marketplace-login' onSubmit={login}>
          <p>Sign in to {provider.label} to browse and install resources.</p>
          <input
            required
            autoComplete='username'
            placeholder='Username'
            value={username}
            onChange={event => setUsername(event.target.value)}
          />
          <input
            required
            type='password'
            autoComplete='current-password'
            placeholder='Password'
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
          <button type='submit' disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : (
        <>
          <form
            className='ws-marketplace-search'
            onSubmit={event => {
              event.preventDefault()
              setSubmittedQuery(query.trim())
              setPage(1)
            }}
          >
            <input
              placeholder={`Search ${
                kind === 'skill'
                  ? 'skills'
                  : kind === 'agent'
                    ? 'agents'
                    : 'AI bundles'
              }…`}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            <button type='submit'>Search</button>
          </form>

          {loading && (
            <div
              className='ws-marketplace-skeleton'
              role='status'
              aria-label='Loading Marketplace'
            >
              <span className='extensions-sr-only'>Loading Marketplace…</span>
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  className='ws-marketplace-skeleton__card'
                  aria-hidden='true'
                >
                  <span className='ws-marketplace-skeleton__title' />
                  <span className='ws-marketplace-skeleton__meta' />
                  <span className='ws-marketplace-skeleton__line' />
                  <span className='ws-marketplace-skeleton__line is-short' />
                </div>
              ))}
            </div>
          )}
          {!loading && catalog?.items?.length === 0 && (
            <div className='ws-marketplace-state ws-marketplace-state--empty'>
              <span className='extensions-blank-state__mark' aria-hidden='true'>
                ◇
              </span>
              <strong>No matching resources</strong>
              <span>Try a different search or resource type.</span>
            </div>
          )}
          {!loading && catalog?.items?.length > 0 && (
            <ul className='ws-panel-list ws-marketplace-list'>
              {catalog.items.map(item => {
                const owned =
                  item.installState === 'installed' ||
                  item.installState === 'updateAvailable'
                const busy =
                  installing === item.externalId ||
                  uninstalling === item.externalId ||
                  previewing === item.externalId
                return (
                  <li
                    key={`${item.kind}:${item.externalId}`}
                    className='ws-panel-item ws-marketplace-card'
                  >
                    <div className='ws-panel-item-row'>
                      <code className='ws-panel-item-name'>{item.name}</code>
                      <span
                        className={`ws-badge ${
                          item.installState === 'installed'
                            ? 'ws-badge--active'
                            : item.installState === 'conflict'
                              ? 'ws-badge--error'
                              : 'ws-badge--shadow'
                        }`}
                      >
                        {MARKETPLACE_STATE_LABELS[item.installState] ||
                          'Available'}
                      </span>
                      {item.version && (
                        <span className='ws-badge ws-badge--type'>
                          v{item.version}
                        </span>
                      )}
                      {item.platformType && (
                        <span className='ws-badge ws-badge--shadow'>
                          {item.platformType}
                        </span>
                      )}
                    </div>
                    {(item.author ||
                      item.category ||
                      item.downloads != null) && (
                      <p className='ws-panel-item-meta'>
                        {[item.author, item.category]
                          .filter(Boolean)
                          .join(' · ')}
                        {item.downloads != null
                          ? `${item.author || item.category ? ' · ' : ''}${item.downloads} installs`
                          : ''}
                      </p>
                    )}
                    {item.description && (
                      <p className='ws-panel-item-desc-short'>
                        {item.description}
                      </p>
                    )}
                    <div className='ws-marketplace-actions'>
                      {item.installState !== 'installed' && (
                        <button
                          type='button'
                          className='ws-marketplace-install'
                          disabled={busy || item.installState === 'conflict'}
                          onClick={() =>
                            item.kind === 'bundle'
                              ? void previewBundle(item)
                              : void install(item)
                          }
                        >
                          {previewing === item.externalId
                            ? 'Preparing…'
                            : installing === item.externalId
                              ? 'Installing…'
                              : item.installState === 'updateAvailable'
                                ? item.kind === 'bundle'
                                  ? 'Review update'
                                  : 'Update'
                                : item.installState === 'conflict'
                                  ? 'Local conflict'
                                  : item.kind === 'bundle'
                                    ? 'Preview'
                                    : 'Download'}
                        </button>
                      )}
                      {owned && (
                        <button
                          type='button'
                          className='ws-marketplace-uninstall'
                          disabled={busy}
                          onClick={() => void uninstall(item)}
                        >
                          {uninstalling === item.externalId
                            ? 'Uninstalling…'
                            : 'Uninstall'}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {bundlePreview && (
            <div
              className='ws-bundle-preview-backdrop'
              role='presentation'
              onClick={() => setBundlePreview(null)}
            >
              <section
                className='ws-bundle-preview'
                role='dialog'
                aria-modal='true'
                aria-labelledby='ws-bundle-preview-title'
                onClick={event => event.stopPropagation()}
              >
                <div className='ws-bundle-preview-head'>
                  <div>
                    <h3 id='ws-bundle-preview-title'>
                      {bundlePreview.item.name}
                    </h3>
                    <p>
                      {bundlePreview.files.length} files
                      {bundlePreview.platformType
                        ? ` · ${bundlePreview.platformType}`
                        : ''}
                    </p>
                  </div>
                  <button
                    type='button'
                    aria-label='Close bundle preview'
                    onClick={() => setBundlePreview(null)}
                  >
                    ×
                  </button>
                </div>
                {bundlePreview.warnings?.map((warning, index) => (
                  <div className='ws-bundle-warning' key={index}>
                    {targetAwareCopy(warning, targetLabel)}
                  </div>
                ))}
                <div className='ws-bundle-files'>
                  {bundlePreview.files.slice(0, 40).map(file => (
                    <div
                      className='ws-bundle-file'
                      key={`${file.sourcePath}:${file.targetPath || ''}`}
                    >
                      <div className='ws-bundle-file-paths'>
                        <code title={file.sourcePath}>{file.sourcePath}</code>
                        {file.targetPath &&
                          file.targetPath !== file.sourcePath && (
                            <code
                              className='ws-bundle-file-target'
                              title={file.targetPath}
                            >
                              → {file.targetPath}
                            </code>
                          )}
                      </div>
                      <span className={`ws-bundle-file-state is-${file.state}`}>
                        {file.state === 'archiveOnly'
                          ? 'archive only'
                          : file.state}
                      </span>
                    </div>
                  ))}
                  {bundlePreview.files.length > 40 && (
                    <p className='ws-panel-empty'>
                      + {bundlePreview.files.length - 40} more files
                    </p>
                  )}
                </div>
                <div className='ws-bundle-preview-actions'>
                  <button type='button' onClick={() => setBundlePreview(null)}>
                    Cancel
                  </button>
                  <button
                    type='button'
                    className='ws-marketplace-install'
                    disabled={
                      !bundlePreview.canInstall ||
                      installing === bundlePreview.item.externalId
                    }
                    onClick={installBundle}
                  >
                    {installing === bundlePreview.item.externalId
                      ? 'Installing…'
                      : bundlePreview.item.installState === 'updateAvailable'
                        ? 'Update bundle'
                        : bundlePreview.requiresConfirmation
                          ? 'Confirm & install'
                          : 'Install bundle'}
                  </button>
                </div>
              </section>
            </div>
          )}

          {catalog && (
            <div className='ws-marketplace-pagination'>
              <span className='ws-marketplace-result-count'>
                {catalog.total != null
                  ? `${catalog.total.toLocaleString()} results`
                  : `${catalog.items?.length ?? 0} shown`}
              </span>
              <button
                type='button'
                aria-label='Previous page'
                disabled={page <= 1 || loading}
                onClick={() => setPage(value => Math.max(1, value - 1))}
              >
                ←
              </button>
              <span className='ws-marketplace-page'>Page {page}</span>
              <button
                type='button'
                aria-label='Next page'
                disabled={
                  loading ||
                  !catalog.items?.length ||
                  catalog.items.length < catalog.perPage ||
                  (catalog.total != null &&
                    page * catalog.perPage >= catalog.total)
                }
                onClick={() => setPage(value => value + 1)}
              >
                →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
