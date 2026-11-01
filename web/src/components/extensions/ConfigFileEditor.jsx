import { useEffect } from 'react'
import { triggerDownload } from '../../lib/api/workspace.js'
import { userConfigApi } from '../../lib/api/user-config.js'
import { basename, isTextResourceFile } from './extensions-model.js'
import useConfigFile from './useConfigFile.js'

export default function ConfigFileEditor({
  path,
  configClient = userConfigApi,
  readOnly = false,
  onSaved,
  onDirtyChange,
}) {
  const editor = useConfigFile(path, {
    enabled: Boolean(path) && isTextResourceFile(path),
    client: configClient,
  })
  const locked = readOnly || Boolean(editor.blockedReason)
  const lockedLabel = editor.file?.isBinary
    ? 'Binary · read-only'
    : editor.file?.truncated
      ? 'Truncated preview · read-only'
      : locked
        ? 'Read-only'
        : null

  useEffect(() => {
    onDirtyChange?.(editor.dirty)
  }, [editor.dirty, onDirtyChange])

  if (!path) {
    return (
      <div className='extensions-editor-placeholder'>
        Select a file to view or edit it.
      </div>
    )
  }

  if (!isTextResourceFile(path)) {
    return (
      <div className='extensions-editor-placeholder'>
        <strong>{basename(path)}</strong>
        <span>This asset is not a text file and cannot be edited here.</span>
        <button
          type='button'
          className='extensions-button'
          onClick={() =>
            void triggerDownload(path, configClient.downloadPath(path))
          }
        >
          Download asset
        </button>
      </div>
    )
  }

  const save = async () => {
    const result = await editor.save()
    if (result) onSaved?.(result)
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

  return (
    <div className='extensions-code-editor'>
      <div className='extensions-code-editor__toolbar'>
        <code title={path}>{path}</code>
        <span className='extensions-code-editor__state'>
          {locked
            ? lockedLabel
            : editor.saving
              ? 'Saving…'
              : editor.dirty
                ? 'Unsaved changes'
                : 'Saved'}
        </span>
        <button
          type='button'
          className='extensions-button extensions-button--compact'
          disabled={editor.loading || editor.saving}
          onClick={reload}
        >
          Reload
        </button>
        {!locked && (
          <button
            type='button'
            className='extensions-button extensions-button--primary extensions-button--compact'
            disabled={
              editor.loading ||
              editor.saving ||
              !editor.dirty ||
              editor.conflict
            }
            onClick={() => void save()}
          >
            Save
          </button>
        )}
      </div>
      {editor.error && (
        <div
          className={`extensions-alert ${editor.conflict ? 'extensions-alert--warning' : 'extensions-alert--error'}`}
          role='alert'
        >
          <span>{editor.error}</span>
          {editor.conflict && (
            <button type='button' onClick={reload}>
              Reload latest
            </button>
          )}
        </div>
      )}
      {editor.blockedReason && (
        <div
          className='extensions-alert extensions-alert--warning'
          role='alert'
        >
          {editor.blockedReason}
        </div>
      )}
      {editor.loading ? (
        <div className='extensions-editor-placeholder'>
          <span className='spinner' aria-hidden='true' />
          Loading file…
        </div>
      ) : (
        <textarea
          className='extensions-code-editor__textarea thin-scrollbar'
          value={editor.content}
          readOnly={locked}
          spellCheck={false}
          aria-label={`Edit ${basename(path)}`}
          onChange={event => editor.setContent(event.target.value)}
          onKeyDown={event => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === 's'
            ) {
              event.preventDefault()
              if (!locked && editor.dirty && !editor.conflict) void save()
            } else if (event.key === 'Tab' && !locked) {
              event.preventDefault()
              const target = event.currentTarget
              const start = target.selectionStart
              const end = target.selectionEnd
              const next =
                editor.content.slice(0, start) +
                '  ' +
                editor.content.slice(end)
              editor.setContent(next)
              requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = start + 2
              })
            }
          }}
        />
      )}
    </div>
  )
}
