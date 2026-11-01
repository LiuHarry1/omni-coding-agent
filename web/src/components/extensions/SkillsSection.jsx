import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentApi } from '../../lib/api/agent.js'
import { userConfigApi } from '../../lib/api/user-config.js'
import { triggerDownload } from '../../lib/api/workspace.js'
import ConfigFileEditor from './ConfigFileEditor.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import DetailPane from './DetailPane.jsx'
import ModalShell from './ModalShell.jsx'
import ResourceList from './ResourceList.jsx'
import StatusBadge from './StatusBadge.jsx'
import { LockIcon } from './icons.jsx'
import { createConfigFile } from './resource-operations.js'
import {
  basename,
  joinConfigPath,
  normalizeConfigTree,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  sourceLabel,
  topLevelResources,
  updateMarkdownBody,
  updateMarkdownFrontmatterField,
} from './extensions-model.js'
import useConfigFile from './useConfigFile.js'

const SKILLS_ROOT = 'skills'

function skillIdentifier(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

function EditableSkillOverview({
  skill,
  onDuplicate,
  configClient,
  onDirtyChange,
}) {
  const path = joinConfigPath(skill.path, 'SKILL.md')
  const editor = useConfigFile(path, { client: configClient })
  const document = useMemo(
    () => parseMarkdownDocument(editor.content),
    [editor.content],
  )
  const readOnly =
    skill.readOnly || Boolean(editor.blockedReason || document.parseError)

  useEffect(() => {
    onDirtyChange?.(editor.dirty)
  }, [editor.dirty, onDirtyChange])

  const updateField = (key, value) => {
    editor.setContent(
      updateMarkdownFrontmatterField(editor.content, key, value),
    )
  }

  const updateBody = body => {
    editor.setContent(updateMarkdownBody(editor.content, body))
  }

  if (editor.loading) {
    return (
      <div className='extensions-editor-placeholder'>
        <span className='spinner' aria-hidden='true' />
        Loading overview…
      </div>
    )
  }

  return (
    <div className='extensions-overview'>
      {readOnly && (
        <div className='extensions-managed-banner'>
          <div>
            <strong>Managed by Marketplace</strong>
            <span>
              Installed resources are read-only so updates can be applied
              safely.
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
            `Frontmatter could not be parsed: ${document.parseError}. Edit SKILL.md in the Files tab to fix it.`}
        </div>
      )}
      <div className='extensions-overview__grid'>
        <label className='extensions-field'>
          <span>Name</span>
          <input
            value={document.frontmatter.name ?? basename(skill.path)}
            readOnly={readOnly}
            onChange={event => updateField('name', event.target.value)}
          />
        </label>
        <label className='extensions-field'>
          <span>Execution context</span>
          <select
            value={document.frontmatter.context ?? 'inline'}
            disabled={readOnly}
            onChange={event => updateField('context', event.target.value)}
          >
            <option value='inline'>Inline</option>
            <option value='fork'>Fork / subagent</option>
          </select>
        </label>
        <label className='extensions-field extensions-field--wide'>
          <span>Description</span>
          <input
            value={document.frontmatter.description ?? ''}
            readOnly={readOnly}
            placeholder='When should the agent use this skill?'
            onChange={event => updateField('description', event.target.value)}
          />
        </label>
        <label className='extensions-field extensions-field--wide'>
          <span>
            Agent <em>optional</em>
          </span>
          <input
            value={document.frontmatter.agent ?? ''}
            readOnly={readOnly}
            placeholder='Specialist agent name'
            onChange={event => updateField('agent', event.target.value)}
          />
        </label>
      </div>
      <label className='extensions-field extensions-overview__instructions'>
        <span>Instructions</span>
        <textarea
          value={document.body}
          readOnly={readOnly}
          spellCheck={false}
          placeholder='Write the skill instructions in Markdown…'
          onChange={event => updateBody(event.target.value)}
          onKeyDown={event => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === 's'
            ) {
              event.preventDefault()
              if (!readOnly && editor.dirty && !editor.conflict) {
                void editor.save()
              }
            }
          }}
        />
      </label>
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
            className='extensions-button extensions-button--primary'
            disabled={
              editor.saving || !editor.dirty || editor.conflict || !editor.file
            }
            onClick={() => void editor.save()}
          >
            Save overview
          </button>
        </div>
      )}
    </div>
  )
}

function SkillOverview(props) {
  const { skill, onDirtyChange } = props
  useEffect(() => {
    if (skill.virtual) onDirtyChange?.(false)
  }, [onDirtyChange, skill.virtual])

  if (!skill.virtual) return <EditableSkillOverview {...props} />
  return (
    <div className='extensions-runtime-overview'>
      <div className='extensions-readonly-hero'>
        <span className='extensions-readonly-hero__icon' aria-hidden='true'>
          ◇
        </span>
        <div>
          <strong>{sourceLabel(skill.source)} runtime skill</strong>
          <p>
            This skill is active in the current runtime but is not writable in
            the selected configuration scope.
          </p>
        </div>
      </div>
      {skill.description && (
        <section className='extensions-summary-card'>
          <span className='extensions-summary-card__label'>Description</span>
          <p>{skill.description}</p>
        </section>
      )}
      <dl className='extensions-metadata-grid'>
        <div>
          <dt>Name</dt>
          <dd>{skill.name}</dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>{skill.context || 'inline'}</dd>
        </div>
        {skill.filePath && (
          <div className='extensions-metadata-grid__wide'>
            <dt>Source file</dt>
            <dd>
              <code title={skill.filePath}>{skill.filePath}</code>
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

function CreateSkillDialog({ open, onClose, onCreated, configClient }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const slug = skillIdentifier(name)

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setBusy(false)
    setError(null)
  }, [open])

  const submit = async event => {
    event.preventDefault()
    if (!slug || busy) return
    setBusy(true)
    setError(null)
    const path = joinConfigPath(SKILLS_ROOT, slug)
    try {
      await configClient.mkdir(path)
      await configClient.create(
        joinConfigPath(path, 'SKILL.md'),
        serializeMarkdownDocument(
          {
            name: slug,
            description:
              description.trim() || 'Describe when to use this skill.',
            context: 'inline',
          },
          '\n# Instructions\n\nAdd instructions for this skill.\n',
        ),
      )
      onCreated(path)
      onClose()
    } catch (err) {
      setError(err?.message || 'Could not create this skill')
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={busy ? undefined : onClose}
      title='Create skill'
      subtitle='Start a user-owned skill package you can edit and export.'
      size='small'
      shouldCloseOnBackdrop={!busy}
    >
      <form className='extensions-form' onSubmit={submit}>
        <label className='extensions-field'>
          <span>Name</span>
          <input
            value={name}
            placeholder='release-notes'
            disabled={busy}
            onChange={event => setName(event.target.value)}
          />
          {name && <small>Folder: skills/{slug || 'invalid-name'}</small>}
        </label>
        <label className='extensions-field'>
          <span>Description</span>
          <textarea
            value={description}
            placeholder='Explain when the agent should use this skill.'
            disabled={busy}
            onChange={event => setDescription(event.target.value)}
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
            disabled={!slug || busy}
          >
            {busy ? 'Creating…' : 'Create skill'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function CreateSkillEntryDialog({
  skill,
  open,
  onClose,
  onCreated,
  configClient,
}) {
  const [kind, setKind] = useState('file')
  const [relativePath, setRelativePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const normalized = relativePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  const valid =
    normalized &&
    !normalized.split('/').some(part => !part || part === '..' || part === '.')

  useEffect(() => {
    if (!open) return
    setKind('file')
    setRelativePath('')
    setBusy(false)
    setError(null)
  }, [open])

  const submit = async event => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const path = joinConfigPath(skill.path, normalized)
    try {
      if (kind === 'folder') await configClient.mkdir(path)
      else await createConfigFile(configClient, path)
      onCreated(path, kind === 'folder')
      onClose()
    } catch (err) {
      setError(err?.message || `Could not create this ${kind}`)
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={busy ? undefined : onClose}
      title='Add to skill'
      size='small'
      shouldCloseOnBackdrop={!busy}
    >
      <form className='extensions-form' onSubmit={submit}>
        <div className='extensions-segmented' role='group' aria-label='Type'>
          <button
            type='button'
            className={kind === 'file' ? 'is-active' : ''}
            onClick={() => setKind('file')}
          >
            File
          </button>
          <button
            type='button'
            className={kind === 'folder' ? 'is-active' : ''}
            onClick={() => setKind('folder')}
          >
            Folder
          </button>
        </div>
        <label className='extensions-field'>
          <span>Path inside {basename(skill.path)}</span>
          <input
            value={relativePath}
            placeholder={
              kind === 'file' ? 'scripts/check.sh' : 'references/examples'
            }
            disabled={busy}
            onChange={event => setRelativePath(event.target.value)}
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
            disabled={!valid || busy}
          >
            {busy ? 'Creating…' : `Create ${kind}`}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

export default function SkillsSection({
  workspace,
  scope = 'user',
  refreshToken = 0,
  configClient = userConfigApi,
  onDirtyChange,
}) {
  const [entries, setEntries] = useState([])
  const [selectedPath, setSelectedPath] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [discoveryWarnings, setDiscoveryWarnings] = useState([])
  const [busyAction, setBusyAction] = useState(null)
  const [creating, setCreating] = useState(false)
  const [creatingEntry, setCreatingEntry] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const packageUploadRef = useRef(null)
  const fileUploadRef = useRef(null)

  useEffect(() => {
    onDirtyChange?.(editorDirty)
  }, [editorDirty, onDirtyChange])

  const skills = useMemo(
    () => topLevelResources(entries, SKILLS_ROOT, { folders: true }),
    [entries],
  )
  const selected = skills.find(skill => skill.path === selectedPath) || null
  const files = useMemo(() => {
    if (!selected) return []
    return entries.filter(
      entry =>
        entry.path.startsWith(`${selected.path}/`) &&
        entry.path !== selected.path,
    )
  }, [entries, selected])

  const load = useCallback(
    async preferredPath => {
      setLoading(true)
      setError(null)
      try {
        const [response, discovery] = await Promise.all([
          configClient.list(SKILLS_ROOT, { recursive: true }),
          agentApi.getSkills(workspace).catch(() => ({ skills: [] })),
        ])
        const summaries = new Map(
          (discovery.skills || []).map(skill => [skill.name, skill]),
        )
        const next = normalizeConfigTree(response, SKILLS_ROOT).map(entry => {
          const summary =
            entry.isDir && entry.path.split('/').length === 2
              ? summaries.get(entry.name)
              : null
          return summary
            ? {
                ...entry,
                ...summary,
                path: entry.path,
                name: entry.name,
                readOnly: entry.readOnly,
                source:
                  entry.source === 'marketplace'
                    ? entry.source
                    : scope === 'workspace'
                      ? 'workspace'
                      : summary.source || entry.source,
              }
            : !entry.readOnly && entry.source === 'user'
              ? {
                  ...entry,
                  source: scope === 'workspace' ? 'workspace' : 'user',
                }
              : entry
        })
        const configuredNames = new Set(
          topLevelResources(next, SKILLS_ROOT, { folders: true }).map(
            skill => skill.name,
          ),
        )
        for (const summary of discovery.skills || []) {
          if (configuredNames.has(summary.name)) continue
          next.push({
            ...summary,
            path: joinConfigPath(
              SKILLS_ROOT,
              `${summary.source || 'runtime'}--${skillIdentifier(summary.name)}`,
            ),
            name: summary.name,
            displayName: summary.name,
            type: 'directory',
            isDir: true,
            source: summary.source || 'plugin',
            readOnly: true,
            virtual: true,
          })
        }
        setDiscoveryWarnings(discovery.errors || [])
        const nextSkills = topLevelResources(next, SKILLS_ROOT, {
          folders: true,
        })
        setEntries(next)
        setSelectedPath(current => {
          const candidate = preferredPath || current
          return nextSkills.some(skill => skill.path === candidate)
            ? candidate
            : nextSkills[0]?.path || null
        })
      } catch (err) {
        setError(err?.message || 'Could not load skills')
        setDiscoveryWarnings([])
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [configClient, scope, workspace],
  )

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  useEffect(() => {
    if (!selected) {
      setSelectedFile(null)
      return
    }
    setSelectedFile(current => {
      if (current && current.startsWith(`${selected.path}/`)) return current
      return joinConfigPath(selected.path, 'SKILL.md')
    })
  }, [selected])

  const duplicate = async skill => {
    setBusyAction('duplicate')
    setError(null)
    try {
      const response = await configClient.duplicate(skill.path)
      const path =
        response?.path || response?.entry?.path || response?.copy?.path || null
      await load(path)
      if (path) setSelectedPath(path)
    } catch (err) {
      setError(err?.message || 'Could not duplicate this skill')
    } finally {
      setBusyAction(null)
    }
  }

  const upload = async (dir, fileList) => {
    if (!fileList?.length) return
    setBusyAction('upload')
    setError(null)
    try {
      await configClient.upload(dir, fileList)
      await load(selectedPath)
    } catch (err) {
      setError(err?.message || 'Upload failed')
    } finally {
      setBusyAction(null)
    }
  }

  const deleteSkill = async () => {
    if (!deleteTarget) return
    setBusyAction('delete')
    setDeleteError(null)
    try {
      await configClient.remove(deleteTarget.path)
      setDeleteTarget(null)
      setSelectedPath(null)
      await load()
    } catch (err) {
      setDeleteError(err?.message || 'Could not delete this skill')
    } finally {
      setBusyAction(null)
    }
  }

  const chooseFile = path => {
    if (
      editorDirty &&
      !window.confirm('Discard unsaved changes and open another file?')
    ) {
      return
    }
    setEditorDirty(false)
    setSelectedFile(path)
  }

  const chooseSkill = skill => {
    if (
      skill.path !== selectedPath &&
      editorDirty &&
      !window.confirm('Discard unsaved changes and open another Skill?')
    ) {
      return
    }
    setEditorDirty(false)
    setSelectedPath(skill.path)
    setTab('overview')
  }

  const chooseTab = nextTab => {
    if (
      nextTab !== tab &&
      editorDirty &&
      !window.confirm('Discard unsaved changes and switch tabs?')
    ) {
      return
    }
    setEditorDirty(false)
    setTab(nextTab)
  }

  return (
    <div className='extensions-section extensions-master-detail'>
      <ResourceList
        title='Skills'
        items={skills}
        selectedId={selected?.path}
        getId={skill => skill.path}
        getLabel={skill => skill.displayName || skill.name}
        getSearchText={skill =>
          `${skill.name} ${skill.description || ''} ${skill.source || ''}`
        }
        renderMeta={skill => (
          <span className='extensions-resource-meta-line'>
            <span>
              {sourceLabel(skill.source)} ·{' '}
              {skill.version ? `v${skill.version}` : 'Unversioned'}
            </span>
            {skill.readOnly && (
              <span
                className='extensions-readonly-lock'
                title='Read-only'
                aria-label='Read-only'
                role='img'
              >
                <LockIcon />
              </span>
            )}
          </span>
        )}
        renderBadges={skill => (
          <StatusBadge status={skill.active ? 'active' : 'conditional'}>
            {skill.active ? 'Active' : 'Conditional'}
          </StatusBadge>
        )}
        loading={loading}
        emptyMessage='No skills installed yet.'
        onSelect={chooseSkill}
        headerActions={
          <div className='extensions-inline-actions'>
            <input
              ref={packageUploadRef}
              type='file'
              accept='.zip'
              hidden
              onChange={event => {
                void upload(SKILLS_ROOT, event.target.files)
                event.target.value = ''
              }}
            />
            <button
              type='button'
              className='extensions-button extensions-button--compact'
              title='Upload skill ZIP'
              aria-label='Upload skill ZIP'
              disabled={busyAction === 'upload'}
              onClick={() => packageUploadRef.current?.click()}
            >
              Import
            </button>
            <button
              type='button'
              className='extensions-icon-button'
              title='Create skill'
              aria-label='Create skill'
              onClick={() => setCreating(true)}
            >
              +
            </button>
          </div>
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
              <strong>Select a skill</strong>
              <span>
                View instructions, edit package files, or create a new skill.
              </span>
            </>
          )
        }
        title={selected?.displayName || selected?.name}
        subtitle={selected?.path}
        badges={
          selected && (
            <>
              <StatusBadge tone='accent'>
                {sourceLabel(selected.source)}
              </StatusBadge>
              {selected.version && (
                <StatusBadge tone='neutral'>v{selected.version}</StatusBadge>
              )}
              <StatusBadge status={selected.active ? 'active' : 'conditional'}>
                {selected.active ? 'Active' : 'Conditional'}
              </StatusBadge>
              {selected.readOnly && (
                <span
                  className='extensions-readonly-lock extensions-readonly-lock--detail'
                  title='Read-only'
                  aria-label='Read-only'
                  role='img'
                >
                  <LockIcon />
                </span>
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
            <strong>Some Skills could not be loaded.</strong>
            {discoveryWarnings.map((warning, index) => (
              <span key={`${warning.filePath || warning.source || index}`}>
                {warning.error || warning.message || String(warning)}
              </span>
            ))}
          </div>
        )}
        {selected && (
          <>
            <div className='extensions-detail-tabs' role='tablist'>
              <button
                type='button'
                role='tab'
                aria-selected={tab === 'overview'}
                className={tab === 'overview' ? 'is-active' : ''}
                onClick={() => chooseTab('overview')}
              >
                Overview
              </button>
              {!selected.virtual && (
                <button
                  type='button'
                  role='tab'
                  aria-selected={tab === 'files'}
                  className={tab === 'files' ? 'is-active' : ''}
                  onClick={() => chooseTab('files')}
                >
                  Files
                </button>
              )}
            </div>
            {tab === 'overview' ? (
              <SkillOverview
                key={selected.path}
                skill={selected}
                configClient={configClient}
                onDirtyChange={setEditorDirty}
                onDuplicate={() => void duplicate(selected)}
              />
            ) : (
              <div className='extensions-skill-files'>
                <aside className='extensions-file-tree'>
                  <div className='extensions-file-tree__toolbar'>
                    <strong>Package files</strong>
                    {!selected.readOnly && (
                      <div className='extensions-inline-actions'>
                        <input
                          ref={fileUploadRef}
                          type='file'
                          multiple
                          hidden
                          onChange={event => {
                            void upload(selected.path, event.target.files)
                            event.target.value = ''
                          }}
                        />
                        <button
                          type='button'
                          className='extensions-icon-button'
                          title='Upload files'
                          aria-label='Upload files'
                          onClick={() => fileUploadRef.current?.click()}
                        >
                          ↑
                        </button>
                        <button
                          type='button'
                          className='extensions-icon-button'
                          title='New file or folder'
                          aria-label='New file or folder'
                          onClick={() => setCreatingEntry(true)}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                  <div className='extensions-file-tree__items thin-scrollbar'>
                    {files.map(entry => {
                      const relative = entry.path.slice(
                        selected.path.length + 1,
                      )
                      const depth = relative.split('/').length - 1
                      return entry.isDir ? (
                        <div
                          key={entry.path}
                          className='extensions-file-tree__folder'
                          style={{ '--file-depth': depth }}
                        >
                          <span aria-hidden='true'>⌄</span>
                          {entry.name}
                        </div>
                      ) : (
                        <button
                          key={entry.path}
                          type='button'
                          className={
                            selectedFile === entry.path ? 'is-active' : ''
                          }
                          style={{ '--file-depth': depth }}
                          title={relative}
                          onClick={() => chooseFile(entry.path)}
                        >
                          <span aria-hidden='true'>#</span>
                          {entry.name}
                        </button>
                      )
                    })}
                  </div>
                </aside>
                <ConfigFileEditor
                  key={selectedFile}
                  path={selectedFile}
                  configClient={configClient}
                  readOnly={selected.readOnly}
                  onDirtyChange={setEditorDirty}
                  onSaved={() => void load(selected.path)}
                />
              </div>
            )}
          </>
        )}
      </DetailPane>

      <CreateSkillDialog
        open={creating}
        configClient={configClient}
        onClose={() => setCreating(false)}
        onCreated={path => void load(path)}
      />
      {selected && (
        <CreateSkillEntryDialog
          skill={selected}
          open={creatingEntry}
          configClient={configClient}
          onClose={() => setCreatingEntry(false)}
          onCreated={(path, isDir) => {
            void load(selected.path)
            if (!isDir) setSelectedFile(path)
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title='Delete skill?'
        message={
          <p>
            <strong>{deleteTarget?.name}</strong> and every script, reference,
            and asset in the package will be permanently deleted.
          </p>
        }
        confirmLabel='Delete skill'
        pending={busyAction === 'delete'}
        error={deleteError}
        onClose={() => {
          setDeleteTarget(null)
          setDeleteError(null)
        }}
        onConfirm={() => void deleteSkill()}
      />
    </div>
  )
}
