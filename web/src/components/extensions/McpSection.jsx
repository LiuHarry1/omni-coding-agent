import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentApi } from '../../lib/api/agent.js'
import { setKnownMcpServers } from '../../lib/tool-kind.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import ModalShell from './ModalShell.jsx'
import StatusBadge from './StatusBadge.jsx'
import {
  MASKED_SECRET,
  isAllowedMcpConfig,
  maskMcpUrl,
  normalizeMcpName,
  normalizeMcpResponse,
  normalizeMcpTransports,
  preferredMcpTransport,
} from './mcp-model.js'

const TRANSPORT_LABELS = {
  stdio: 'Local command (stdio)',
  http: 'Streamable HTTP',
  sse: 'Server-sent events (SSE)',
}
const DEFAULT_MCP_TRANSPORTS = ['http', 'sse']

function rowsToObject(rows) {
  return Object.fromEntries(
    rows
      .map(row => [row.name.trim(), row.value])
      .filter(([name]) => Boolean(name)),
  )
}

function AddMcpDialog({ open, onClose, onSaved, transports }) {
  const availableTransports = useMemo(
    () => normalizeMcpTransports(transports),
    [transports],
  )
  const [name, setName] = useState('')
  const [transport, setTransport] = useState(
    preferredMcpTransport(availableTransports),
  )
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState([{ name: '', value: '' }])
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [environment, setEnvironment] = useState([{ name: '', value: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setTransport(preferredMcpTransport(availableTransports))
    setUrl('')
    setHeaders([{ name: '', value: '' }])
    setCommand('')
    setArgs('')
    setEnvironment([{ name: '', value: '' }])
    setBusy(false)
    setError(null)
  }, [availableTransports, open])

  const normalizedName = normalizeMcpName(name)
  const config = useMemo(() => {
    if (transport === 'stdio') {
      const parsedArgs = args
        .split('\n')
        .map(argument => argument.trim())
        .filter(Boolean)
      const env = rowsToObject(environment)
      return {
        transport,
        command: command.trim(),
        ...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      }
    }
    const savedHeaders = rowsToObject(headers)
    return {
      transport,
      url: url.trim(),
      ...(Object.keys(savedHeaders).length > 0
        ? { headers: savedHeaders }
        : {}),
    }
  }, [args, command, environment, headers, transport, url])
  const valid =
    normalizedName && isAllowedMcpConfig(config, availableTransports)

  const clearAndClose = () => {
    setUrl('')
    setHeaders(current => current.map(header => ({ ...header, value: '' })))
    setEnvironment(current =>
      current.map(variable => ({ ...variable, value: '' })),
    )
    onClose()
  }

  const submit = async event => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const persistedConfig =
        transport === 'stdio'
          ? {
              command: config.command,
              ...(config.args ? { args: config.args } : {}),
              ...(config.env ? { env: config.env } : {}),
            }
          : config
      const response = await agentApi.addMcp(normalizedName, persistedConfig)
      onSaved(response, {
        name: normalizedName,
        transport,
        url: config.url || '',
        headers: Object.keys(config.headers || {}),
      })
      clearAndClose()
    } catch (err) {
      setError(err?.message || 'Could not connect to this MCP server')
      setBusy(false)
    }
  }

  const updateRow = (setter, index, key, value) => {
    setter(current =>
      current.map((header, itemIndex) =>
        itemIndex === index ? { ...header, [key]: value } : header,
      ),
    )
  }

  return (
    <ModalShell
      open={open}
      onClose={busy ? undefined : clearAndClose}
      title='Add MCP server'
      subtitle={
        availableTransports.length > 0
          ? `Available transports: ${availableTransports
              .map(item => TRANSPORT_LABELS[item])
              .join(', ')}.`
          : 'No MCP transports are enabled by the server.'
      }
      size='small'
      shouldCloseOnBackdrop={!busy}
    >
      <form className='extensions-form' onSubmit={submit}>
        <label className='extensions-field'>
          <span>Name</span>
          <input
            value={name}
            placeholder='docs'
            disabled={busy}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className='extensions-field'>
          <span>Transport</span>
          <select
            value={transport}
            disabled={busy || availableTransports.length === 0}
            onChange={event => setTransport(event.target.value)}
          >
            {availableTransports.map(item => (
              <option key={item} value={item}>
                {TRANSPORT_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label className='extensions-field'>
              <span>Command</span>
              <input
                value={command}
                placeholder='npx'
                disabled={busy}
                onChange={event => setCommand(event.target.value)}
              />
            </label>
            <label className='extensions-field'>
              <span>
                Arguments <em>optional, one per line</em>
              </span>
              <textarea
                value={args}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
                disabled={busy}
                onChange={event => setArgs(event.target.value)}
              />
            </label>
            <fieldset className='extensions-headers-field'>
              <legend>
                Environment variables <em>optional</em>
              </legend>
              <p>
                Values are write-only and are not displayed after this form
                closes.
              </p>
              {environment.map((variable, index) => (
                <div className='extensions-header-row' key={index}>
                  <input
                    aria-label={`Environment variable ${index + 1} name`}
                    value={variable.name}
                    placeholder='API_KEY'
                    disabled={busy}
                    onChange={event =>
                      updateRow(
                        setEnvironment,
                        index,
                        'name',
                        event.target.value,
                      )
                    }
                  />
                  <input
                    type='password'
                    aria-label={`Environment variable ${index + 1} value`}
                    value={variable.value}
                    placeholder='Secret value'
                    disabled={busy}
                    onChange={event =>
                      updateRow(
                        setEnvironment,
                        index,
                        'value',
                        event.target.value,
                      )
                    }
                  />
                  <button
                    type='button'
                    className='extensions-icon-button'
                    aria-label={`Remove environment variable ${index + 1}`}
                    disabled={busy || environment.length === 1}
                    onClick={() =>
                      setEnvironment(current =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type='button'
                className='extensions-button extensions-button--compact'
                disabled={busy}
                onClick={() =>
                  setEnvironment(current => [
                    ...current,
                    { name: '', value: '' },
                  ])
                }
              >
                + Add variable
              </button>
            </fieldset>
          </>
        ) : (
          <>
            <label className='extensions-field'>
              <span>Server URL</span>
              <input
                type='url'
                value={url}
                placeholder='https://mcp.example.com/mcp'
                disabled={busy}
                onChange={event => setUrl(event.target.value)}
              />
            </label>
            <fieldset className='extensions-headers-field'>
              <legend>
                Request headers <em>optional</em>
              </legend>
              <p>
                Header values are write-only and are masked after this form
                closes.
              </p>
              {headers.map((header, index) => (
                <div className='extensions-header-row' key={index}>
                  <input
                    aria-label={`Header ${index + 1} name`}
                    value={header.name}
                    placeholder='Authorization'
                    disabled={busy}
                    onChange={event =>
                      updateRow(setHeaders, index, 'name', event.target.value)
                    }
                  />
                  <input
                    type='password'
                    aria-label={`Header ${index + 1} value`}
                    value={header.value}
                    placeholder='Secret value'
                    disabled={busy}
                    onChange={event =>
                      updateRow(setHeaders, index, 'value', event.target.value)
                    }
                  />
                  <button
                    type='button'
                    className='extensions-icon-button'
                    aria-label={`Remove header ${index + 1}`}
                    disabled={busy || headers.length === 1}
                    onClick={() =>
                      setHeaders(current =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type='button'
                className='extensions-button extensions-button--compact'
                disabled={busy}
                onClick={() =>
                  setHeaders(current => [...current, { name: '', value: '' }])
                }
              >
                + Add header
              </button>
            </fieldset>
          </>
        )}
        {availableTransports.length === 0 && (
          <div
            className='extensions-alert extensions-alert--warning'
            role='status'
          >
            MCP server creation is disabled by the runtime capability manifest.
          </div>
        )}
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
            onClick={clearAndClose}
          >
            Cancel
          </button>
          <button
            type='submit'
            className='extensions-button extensions-button--primary'
            disabled={!valid || busy}
          >
            {busy
              ? transport === 'stdio'
                ? 'Starting command…'
                : 'Testing connection…'
              : 'Test & save'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

export default function McpSection({
  workspace,
  refreshToken = 0,
  capability = { enabled: true, reason: null },
  transports = DEFAULT_MCP_TRANSPORTS,
}) {
  const [servers, setServers] = useState([])
  const [remembered, setRemembered] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [removeTarget, setRemoveTarget] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState(null)
  const availableTransports = useMemo(
    () => normalizeMcpTransports(transports),
    [transports],
  )
  const operationReason =
    capability.reason ||
    (availableTransports.length === 0
      ? 'No MCP transports are enabled by the runtime capability manifest.'
      : null)
  const canModify = capability.enabled && availableTransports.length > 0

  const applyResponse = useCallback(
    response => {
      const next = normalizeMcpResponse(response, remembered)
      setServers(next)
      setKnownMcpServers(next.map(server => server.name))
      return next
    },
    [remembered],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      applyResponse(await agentApi.getMcp(workspace))
    } catch (err) {
      setError(err?.message || 'Could not load MCP servers')
    } finally {
      setLoading(false)
    }
  }, [applyResponse, workspace])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const remove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    setRemoveError(null)
    try {
      const response = await agentApi.removeMcp(
        removeTarget.name,
        removeTarget.writableScope,
      )
      setRemembered(current => {
        const next = { ...current }
        delete next[removeTarget.name]
        return next
      })
      applyResponse(response)
      setRemoveTarget(null)
    } catch (err) {
      setRemoveError(err?.message || 'Could not remove this MCP server')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className='extensions-section extensions-mcp'>
      <div className='extensions-section__toolbar'>
        <div>
          <h2>Model Context Protocol</h2>
          <p>Connect approved services to give the agent more tools.</p>
        </div>
        <div className='extensions-inline-actions'>
          <button
            type='button'
            className='extensions-button'
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type='button'
            className='extensions-button extensions-button--primary'
            disabled={!canModify}
            title={canModify ? 'Add MCP server' : operationReason}
            onClick={() => setAdding(true)}
          >
            + Add server
          </button>
        </div>
      </div>
      <div className='extensions-info-banner'>
        <strong>Runtime transport policy</strong>
        <span>
          {availableTransports.length > 0
            ? `Available transports: ${availableTransports
                .map(transport => TRANSPORT_LABELS[transport])
                .join(
                  ', ',
                )}. Backend policy is enforced when configurations are saved.`
            : operationReason}
        </span>
      </div>
      {error && (
        <div className='extensions-alert extensions-alert--error' role='alert'>
          {error}
        </div>
      )}
      {!loading && servers.length === 0 ? (
        <div className='extensions-blank-state'>
          <span className='extensions-blank-state__mark'>⌁</span>
          <h3>No MCP servers connected</h3>
          <p>Add an allowed MCP server to make its tools available.</p>
          <button
            type='button'
            className='extensions-button extensions-button--primary'
            disabled={!canModify}
            title={canModify ? 'Add MCP server' : operationReason}
            onClick={() => setAdding(true)}
          >
            Add MCP server
          </button>
        </div>
      ) : (
        <div className='extensions-status-grid'>
          {servers.map(server => (
            <article key={server.name} className='extensions-status-card'>
              <div className='extensions-status-card__head'>
                <div>
                  <h3>{server.name}</h3>
                  {server.url ? (
                    <code title={server.url}>{server.url}</code>
                  ) : (
                    <p>Endpoint details are protected</p>
                  )}
                </div>
                <StatusBadge status={server.status} title={server.error}>
                  {server.status}
                </StatusBadge>
              </div>
              <div className='extensions-status-card__meta'>
                <span>{server.transport.toUpperCase()}</span>
                <span>Source: {server.configuredBy}</span>
                <span>
                  {server.tools.length}{' '}
                  {server.tools.length === 1 ? 'tool' : 'tools'}
                </span>
              </div>
              {server.headerNames.length > 0 && (
                <div
                  className='extensions-token-list'
                  aria-label='Saved request headers'
                >
                  {server.headerNames.map(header => (
                    <span key={header}>
                      {header} <b>{MASKED_SECRET}</b>
                    </span>
                  ))}
                </div>
              )}
              {server.tools.length > 0 && (
                <div className='extensions-token-list'>
                  {server.tools.map(tool => (
                    <span key={tool}>{tool}</span>
                  ))}
                </div>
              )}
              {server.error && (
                <div className='extensions-alert extensions-alert--error'>
                  {server.error}
                </div>
              )}
              <div className='extensions-status-card__actions'>
                <button
                  type='button'
                  className='extensions-button extensions-button--danger-ghost'
                  disabled={!capability.enabled || !server.writable}
                  title={
                    !server.writable
                      ? `This server is provided by ${server.configuredBy} and is read-only`
                      : capability.enabled
                        ? 'Remove MCP server'
                        : operationReason
                  }
                  onClick={() => setRemoveTarget(server)}
                >
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <AddMcpDialog
        open={adding}
        transports={availableTransports}
        onClose={() => setAdding(false)}
        onSaved={(response, detail) => {
          setRemembered(current => ({
            ...current,
            [detail.name]: {
              transport: detail.transport,
              url: maskMcpUrl(detail.url),
              headers: Object.fromEntries(
                detail.headers.map(name => [name, MASKED_SECRET]),
              ),
            },
          }))
          applyResponse(response)
        }}
      />
      <ConfirmDialog
        open={Boolean(removeTarget)}
        title='Remove MCP server?'
        message={
          <p>
            <strong>{removeTarget?.name}</strong> will disconnect and its tools
            will no longer be available to the agent.
          </p>
        }
        confirmLabel='Remove server'
        pending={removing}
        error={removeError}
        onClose={() => {
          setRemoveTarget(null)
          setRemoveError(null)
        }}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
