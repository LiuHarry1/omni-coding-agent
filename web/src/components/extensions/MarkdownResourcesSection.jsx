import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentApi } from '../../lib/api/agent.js'
import { userConfigApi } from '../../lib/api/user-config.js'
import { triggerDownload } from '../../lib/api/workspace.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import DetailPane from './DetailPane.jsx'
import ModalShell from './ModalShell.jsx'
import ResourceList from './ResourceList.jsx'
import StatusBadge from './StatusBadge.jsx'
import { createConfigFile } from './resource-operations.js'
import {
  extensionlessName,
  joinConfigPath,
  normalizeConfigTree,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  slugifyResourceName,
  sourceLabel,
  updateMarkdownBody,
  updateMarkdownFrontmatterField,
} from './extensions-model.js'
import useConfigFile from './useConfigFile.js'

export const MARKDOWN_RESOURCE_CONFIG = {
  agents: {
    label: 'Agents',
    singular: 'agent',
    description: 'Specialist and primary agent profiles.',
    fields: [
      { key: 'label', label: 'Display label' },
      { key: 'description', label: 'Description', wide: true },
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          ['subagent', 'Subagent'],
          ['primary', 'Primary'],
          ['all', 'Both'],
        ],
      },
      { key: 'model', label: 'Model override', placeholder: 'Default model' },
    ],
    defaults: name => ({
      name,
      label: name
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' '),
      description: 'Describe when this agent should be used.',
      mode: 'subagent',
    }),
    body: '\nYou are a specialist agent. Describe your role and approach here.\n',
  },
  rules: {
    label: 'Rules',
    singular: 'rule',
    description: 'Reusable instructions applied to agent work.',
    fields: [
      {
        key: 'paths',
        label: 'Path patterns',
        type: 'list',
        wide: true,
        placeholder: 'src/**, tests/**',
        hint: 'Leave empty to apply this rule everywhere.',
      },
    ],
    defaults: () => ({}),
    body: '\n# Rule\n\nWrite the instruction the agent should follow.\n',
  },
  commands: {
    label: 'Commands',
    singular: 'command',
    description: 'Markdown templates available as slash commands.',
    fields: [
      { key: 'description', label: 'Description', wide: true },
      {
        key: 'argument-hint',
        label: 'Argument hint',
        placeholder: '[optional argument]',
      },
      {
        key: 'arguments',
        label: 'Named arguments',
        placeholder: 'path focus',
        hint: 'Space-separated names for $path-style substitutions.',
      },
      { key: 'model', label: 'Model override', placeholder: 'Default model' },
    ],
    defaults: name => ({
      description: `Run the /${name} command.`,
    }),
    body: '\nWrite the command prompt here. Use $ARGUMENTS for user input.\n',
  },
}

function resourceKey(path) {
  return path.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() || ''
}

function discoveryResources(type, payload) {
  const items =
    type === 'agents'
      ? payload?.all || payload?.agents || []
      : (Array.isArray(payload) ? payload : payload?.entries || []).filter(
          item => item.kind === 'built-in' || item.kind === 'command',
        )

  return items.map(item => {
    const name = type === 'agents' ? item.agentType : item.name
    const source =
      item.source || (item.kind === 'built-in' ? 'built-in' : 'runtime')
    const description =
      item.description || item.whenToUse || 'Runtime-provided extension.'
    return {
      type: 'file',
      path: `__runtime__/${source}/${name}.md`,
      name: `${name}.md`,
      title: name,
      logicalName: String(name).toLowerCase(),
      source,
      description,
      filePath: item.filePath,
      readOnly: true,
      virtual: true,
      discovery: item,
    }
  })
}

function VirtualResourceOverview({ resource, type }) {
  const details =
    type === 'agents'
      ? [
          ['When to use', resource.discovery.whenToUse, true],
          ['Model', resource.discovery.model],
          [
            'Tools',
            Array.isArray(resource.discovery.tools)
              ? resource.discovery.tools.join(', ')
              : null,
            true,
          ],
        ]
      : [
          ['Kind', resource.discovery.kind],
          ['Arguments', resource.discovery.argumentHint, true],
        ]

  return (
    <div className='extensions-runtime-overview'>
      <div className='extensions-readonly-hero'>
        <span className='extensions-readonly-hero__icon' aria-hidden='true'>
          ◇
        </span>
        <div>
          <strong>
            Runtime-provided {type === 'agents' ? 'agent' : 'command'}
          </strong>
          <p>
            This read-only resource was discovered from{' '}
            {sourceLabel(resource.source)}. Duplicate it into this scope when
            you need an editable copy.
          </p>
        </div>
      </div>
      <section className='extensions-summary-card'>
        <span className='extensions-summary-card__label'>Description</span>
        <p>{resource.description}</p>
      </section>
      <dl className='extensions-metadata-grid'>
        {details.map(
          ([label, value, wide]) =>
            value && (
              <div
                key={label}
                className={wide ? 'extensions-metadata-grid__wide' : undefined}
              >
                <dt>{label}</dt>
                <dd>{String(value)}</dd>
              </div>
            ),
        )}
        {resource.filePath && (
          <div className='extensions-metadata-grid__wide'>
            <dt>Source file</dt>
            <dd>
              <code title={resource.filePath}>{resource.filePath}</code>
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

function MarkdownDocumentEditor({
  resource,
  config,
  onDuplicate,
  configClient,
  onDirtyChange,
}) {
  const editor = useConfigFile(resource.path, { client: configClient })
  const [mode, setMode] = useState('form')
  const [listDrafts, setListDrafts] = useState({})
  const document = useMemo(
    () => parseMarkdownDocument(editor.content),
    [editor.content],
  )
  const readOnly = resource.readOnly || Boolean(editor.blockedReason)

  useEffect(() => {
    onDirtyChange?.(editor.dirty)
  }, [editor.dirty, onDirtyChange])

  useEffect(() => {
    setListDrafts({})
  }, [editor.file?.mtimeMs, resource.path])

  useEffect(() => {
    if (document.parseError) setMode('source')
  }, [document.parseError])

  const updateField = (field, value) => {
    const next =
      field.type === 'list'
        ? String(value)
            .split(',')
            .map(item => item.trim())
            .filter(Boolean)
        : value
    editor.setContent(
      updateMarkdownFrontmatterField(editor.content, field.key, next),
    )
  }

  const valueFor = field => {
    const value = document.frontmatter[field.key]
    return Array.isArray(value) ? value.join(', ') : (value ?? '')
  }

  const reload = () => {
    if (
      editor.dirty &&
      !window.confirm('Discard unsaved changes and reload this file?')
    ) {
      return
    }
    void editor.load()
  }

  const saveShortcut = event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!readOnly && editor.dirty && !editor.conflict) void editor.save()
    }
  }

  if (editor.loading) {
    return (
      <div className='extensions-editor-placeholder'>
        <span className='spinner' aria-hidden='true' />
        Loading document…
      </div>
    )
  }

  return (
    <div className='extensions-markdown-editor'>
      {readOnly && (
        <div className='extensions-managed-banner'>
          <div>
            <strong>Managed resource</strong>
            <span>
              Duplicate this Marketplace resource to create an editable copy.
            </span>
          </div>
          <button
            type='button'
            className='extensions-button'
            onClick={onDuplicate}
          >
            Duplicate to edit
          </button>
        </div>
      )}
      {editor.error && (
        <div
          className={`extensions-alert ${editor.conflict ? 'extensions-alert--warning' : 'extensions-alert--error'}`}
          role='alert'
        >
          <span>{editor.error}</span>
          {editor.conflict && (
            <button type='button' onClick={() => void editor.load()}>
              Reload latest
            </button>
          )}
        </div>
      )}
      {(editor.blockedReason || document.parseError) && (
        <div
          className='extensions-alert extensions-alert--warning'
          role='alert'
        >
          {editor.blockedReason ||
            `Frontmatter could not be parsed: ${document.parseError}. Use Source mode to fix it.`}
        </div>
      )}
      <div className='extensions-editor-mode' role='tablist'>
        <button
          type='button'
          role='tab'
          aria-selected={mode === 'form'}
          className={mode === 'form' ? 'is-active' : ''}
          onClick={() => setMode('form')}
        >
          Editor
        </button>
        <button
          type='button'
          role='tab'
          aria-selected={mode === 'source'}
          className={mode === 'source' ? 'is-active' : ''}
          onClick={() => setMode('source')}
        >
          Source
        </button>
      </div>

      {mode === 'form' ? (
        <div className='extensions-markdown-editor__form'>
          {config.fields.length > 0 && (
            <div className='extensions-overview__grid'>
              {config.fields.map(field => (
                <label
                  key={field.key}
                  className={`extensions-field ${field.wide ? 'extensions-field--wide' : ''}`}
                >
                  <span>{field.label}</span>
                  {field.type === 'select' ? (
                    <select
                      value={valueFor(field)}
                      disabled={readOnly}
                      onChange={event => updateField(field, event.target.value)}
                    >
                      {field.options.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={
                        field.type === 'list'
                          ? (listDrafts[field.key] ?? valueFor(field))
                          : valueFor(field)
                      }
                      readOnly={readOnly}
                      placeholder={field.placeholder}
                      onChange={event => {
                        if (field.type === 'list') {
                          setListDrafts(current => ({
                            ...current,
                            [field.key]: event.target.value,
                          }))
                        }
                        updateField(field, event.target.value)
                      }}
                    />
                  )}
                  {field.hint && <small>{field.hint}</small>}
                </label>
              ))}
            </div>
          )}
          <label className='extensions-field extensions-markdown-body'>
            <span>Markdown instructions</span>
            <textarea
              value={document.body}
              readOnly={readOnly}
              spellCheck={false}
              onChange={event =>
                editor.setContent(
                  updateMarkdownBody(editor.content, event.target.value),
                )
              }
              onKeyDown={saveShortcut}
            />
          </label>
        </div>
      ) : (
        <textarea
          className='extensions-source-editor thin-scrollbar'
          value={editor.content}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={`Edit ${resource.name} source`}
          onChange={event => editor.setContent(event.target.value)}
          onKeyDown={saveShortcut}
        />
      )}

      {!readOnly && (
        <div className='extensions-editor-footer'>
          <span>
            {editor.saving
              ? 'Saving…'
              : editor.dirty
                ? 'Unsaved changes'
                : 'All changes saved'}
          </span>
          <button
            type='button'
            className='extensions-button extensions-button--compact'
            disabled={editor.loading || editor.saving}
            onClick={reload}
          >
            Reload
          </button>
          <button
            type='button'
            className='extensions-button extensions-button--primary'
            disabled={
              !editor.file || !editor.dirty || editor.saving || editor.conflict
            }
            onClick={() => void editor.save()}
          >
            Save changes
          </button>
        </div>
      )}
    </div>
  )
}

function CreateMarkdownDialog({
  open,
  type,
  config,
  onClose,
  onCreated,
  configClient,
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const slug = slugifyResourceName(name)

  useEffect(() => {
    if (!open) return
    setName('')
    setBusy(false)
    setError(null)
  }, [open])

  const submit = async event => {
    event.preventDefault()
    if (!slug || busy) return
    const path = joinConfigPath(type, `${slug}.md`)
    setBusy(true)
    setError(null)
    try {
      await createConfigFile(
        configClient,
        path,
        serializeMarkdownDocument(config.defaults(slug), config.body),
      )
      onCreated(path)
      onClose()
    } catch (err) {
      setError(err?.message || `Could not create this ${config.singular}`)
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={busy ? undefined : onClose}
      title={`Create ${config.singular}`}
      size='small'
      shouldCloseOnBackdrop={!busy}
    >
      <form className='extensions-form' onSubmit={submit}>
        <label className='extensions-field'>
          <span>Name</span>
          <input
            value={name}
            placeholder={`my-${config.singular}`}
            disabled={busy}
            onChange={event => setName(event.target.value)}
          />
          {name && (
            <small>
              File: {type}/{slug || 'invalid-name'}.md
            </small>
          )}
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
            disabled={!slug || busy}
          >
            {busy ? 'Creating…' : `Create ${config.singular}`}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

export default function MarkdownResourcesSection({
  type,
  scope = 'user',
  workspace,
  refreshToken = 0,
  configClient = userConfigApi,
  onDirtyChange,
}) {
  const config = MARKDOWN_RESOURCE_CONFIG[type]
  const [entries, setEntries] = useState([])
  const [selectedPath, setSelectedPath] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [busyAction, setBusyAction] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [discovered, setDiscovered] = useState([])
  const [discoveryWarnings, setDiscoveryWarnings] = useState([])

  useEffect(() => {
    onDirtyChange?.(editorDirty)
  }, [editorDirty, onDirtyChange])

  const resources = useMemo(() => {
    const editable = entries.filter(
      entry => !entry.isDir && entry.path.toLowerCase().endsWith('.md'),
    )
    const editableKeys = new Set(editable.map(entry => resourceKey(entry.path)))
    const virtual =
      type === 'agents' || type === 'commands'
        ? discovered.filter(
            entry =>
              !editableKeys.has(entry.logicalName) ||
              !['user', 'project', 'workspace'].includes(entry.source),
          )
        : []
    return [...editable, ...virtual]
  }, [discovered, entries, type])

  useEffect(() => {
    let cancelled = false
    if (type !== 'agents' && type !== 'commands') {
      setDiscovered([])
      setDiscoveryWarnings([])
      return undefined
    }

    const discover =
      type === 'agents' ? agentApi.getAgents : agentApi.getSlashCommands
    void discover(workspace)
      .then(response => {
        if (cancelled) return
        setDiscovered(discoveryResources(type, response))
        setDiscoveryWarnings(response?.errors || [])
      })
      .catch(err => {
        if (cancelled) return
        setDiscovered([])
        setDiscoveryWarnings([
          {
            message:
              err?.message ||
              `Could not discover runtime ${config.label.toLowerCase()}`,
          },
        ])
      })

    return () => {
      cancelled = true
    }
  }, [config.label, refreshToken, type, workspace])

  useEffect(() => {
    setSelectedPath(current =>
      resources.some(resource => resource.path === current)
        ? current
        : resources[0]?.path || null,
    )
  }, [resources])
  const selected =
    resources.find(resource => resource.path === selectedPath) || null

  const load = useCallback(
    async preferredPath => {
      setLoading(true)
      setError(null)
      try {
        const response = await configClient.list(type, { recursive: true })
        const next = normalizeConfigTree(response, type).map(entry =>
          !entry.readOnly && entry.source === 'user'
            ? {
                ...entry,
                source: scope === 'workspace' ? 'workspace' : 'user',
              }
            : entry,
        )
        const nextResources = next.filter(
          entry => !entry.isDir && entry.path.toLowerCase().endsWith('.md'),
        )
        setEntries(next)
        setSelectedPath(current => {
          const candidate = preferredPath || current
          return nextResources.some(resource => resource.path === candidate)
            ? candidate
            : nextResources[0]?.path || null
        })
      } catch (err) {
        setError(err?.message || `Could not load ${config.label.toLowerCase()}`)
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [config.label, configClient, scope, type],
  )

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const duplicate = async resource => {
    setBusyAction('duplicate')
    setError(null)
    try {
      const response = await configClient.duplicate(resource.path)
      const path = response?.path || response?.entry?.path || null
      await load(path)
      if (path) setSelectedPath(path)
    } catch (err) {
      setError(err?.message || `Could not duplicate this ${config.singular}`)
    } finally {
      setBusyAction(null)
    }
  }

  const deleteResource = async () => {
    if (!deleteTarget) return
    setBusyAction('delete')
    setDeleteError(null)
    try {
      await configClient.remove(deleteTarget.path)
      setDeleteTarget(null)
      setSelectedPath(null)
      await load()
    } catch (err) {
      setDeleteError(err?.message || `Could not delete this ${config.singular}`)
    } finally {
      setBusyAction(null)
    }
  }

  const selectResource = resource => {
    if (
      resource.path !== selectedPath &&
      editorDirty &&
      !window.confirm('Discard unsaved changes and open another resource?')
    ) {
      return
    }
    setEditorDirty(false)
    setSelectedPath(resource.path)
  }

  return (
    <div className='extensions-section extensions-master-detail'>
      <ResourceList
        title={config.label}
        items={resources}
        selectedId={selected?.path}
        getId={resource => resource.path}
        getLabel={resource =>
          resource.displayName ||
          resource.title ||
          extensionlessName(resource.path)
        }
        getSearchText={resource =>
          `${resource.path} ${resource.description || ''}`
        }
        renderMeta={resource => sourceLabel(resource.source)}
        renderBadges={resource =>
          resource.readOnly ? (
            <StatusBadge status='readonly'>Read-only</StatusBadge>
          ) : null
        }
        loading={loading}
        emptyMessage={`No ${config.label.toLowerCase()} yet.`}
        onSelect={selectResource}
        headerActions={
          <button
            type='button'
            className='extensions-icon-button'
            title={`Create ${config.singular}`}
            aria-label={`Create ${config.singular}`}
            onClick={() => setCreating(true)}
          >
            +
          </button>
        }
      />
      <DetailPane
        empty={!selected}
        emptyContent={
          error ? (
            <div className='extensions-alert extensions-alert--error'>
              {error}
              <button type='button' onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <strong>Select a {config.singular}</strong>
              <span>{config.description}</span>
            </>
          )
        }
        title={
          selected?.displayName ||
          selected?.title ||
          (selected ? extensionlessName(selected.path) : '')
        }
        subtitle={selected?.filePath || selected?.path}
        badges={
          selected && (
            <>
              <StatusBadge tone='accent'>
                {sourceLabel(selected.source)}
              </StatusBadge>
              {selected.readOnly && (
                <StatusBadge status='readonly'>Read-only</StatusBadge>
              )}
            </>
          )
        }
        actions={
          selected && (
            <>
              {!selected.virtual && (
                <>
                  <button
                    type='button'
                    className='extensions-button'
                    disabled={busyAction === 'duplicate'}
                    onClick={() => void duplicate(selected)}
                  >
                    {selected.readOnly ? 'Duplicate to edit' : 'Duplicate'}
                  </button>
                  <button
                    type='button'
                    className='extensions-button'
                    onClick={() =>
                      void triggerDownload(
                        selected.path,
                        configClient.downloadPath(selected.path),
                      )
                    }
                  >
                    Export
                  </button>
                </>
              )}
              {!selected.readOnly && (
                <button
                  type='button'
                  className='extensions-button extensions-button--danger-ghost'
                  onClick={() => setDeleteTarget(selected)}
                >
                  Delete
                </button>
              )}
            </>
          )
        }
      >
        {error && (
          <div
            className='extensions-alert extensions-alert--error'
            role='alert'
          >
            {error}
          </div>
        )}
        {discoveryWarnings.length > 0 && (
          <div
            className='extensions-alert extensions-alert--warning extensions-alert--stacked'
            role='alert'
          >
            <strong>Some {config.label} could not be loaded.</strong>
            {discoveryWarnings.map((warning, index) => (
              <span key={`${warning.source || warning.filePath || index}`}>
                {warning.message || warning.error || String(warning)}
              </span>
            ))}
          </div>
        )}
        {selected &&
          (selected.virtual ? (
            <VirtualResourceOverview resource={selected} type={type} />
          ) : (
            <MarkdownDocumentEditor
              key={selected.path}
              resource={selected}
              config={config}
              configClient={configClient}
              onDirtyChange={setEditorDirty}
              onDuplicate={() => void duplicate(selected)}
            />
          ))}
      </DetailPane>
      <CreateMarkdownDialog
        open={creating}
        type={type}
        config={config}
        configClient={configClient}
        onClose={() => setCreating(false)}
        onCreated={path => void load(path)}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${config.singular}?`}
        message={
          <p>
            <strong>
              {deleteTarget ? extensionlessName(deleteTarget.path) : ''}
            </strong>{' '}
            will be permanently deleted.
          </p>
        }
        confirmLabel={`Delete ${config.singular}`}
        pending={busyAction === 'delete'}
        error={deleteError}
        onClose={() => {
          setDeleteTarget(null)
          setDeleteError(null)
        }}
        onConfirm={() => void deleteResource()}
      />
    </div>
  )
}
