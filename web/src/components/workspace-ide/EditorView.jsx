import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  downloadEntry,
  entryBlobUrl,
  useWorkspaceIdeStore,
} from '../../stores/workspace-ide-store.js'
import CopyButton from '../CopyButton.jsx'
import { languageLabel, buildBreadcrumb } from './helpers.js'
import { DownloadIcon } from './icons.jsx'
import { fileName } from '../../lib/utils.js'
import DiffView from './DiffView.jsx'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'])

/**
 * File editor used inside the WorkspaceIDE. Opens directly in editable
 * mode for any text file — there is no "view-only" toggle. Two cases
 * fall back to read-only:
 *   - binary files
 *   - files truncated by the read endpoint (editing would lose data)
 *
 * Draft content + dirty bit live in the workspace-ide-store keyed by
 * absolute path, so switching tabs preserves edits in flight.
 */
export default function EditorView() {
  const activeKind = useWorkspaceIdeStore(s => s.activeKind)
  const activeFile = useWorkspaceIdeStore(s => s.activeFile)
  const data = useWorkspaceIdeStore(s =>
    activeFile ? s.fileContents[activeFile] : null,
  )
  const workspace = useWorkspaceIdeStore(s => s.rootPath)

  if (activeKind === 'diff') return <DiffView />
  if (!activeFile) return <EmptyState />
  if (!data || data.loading)
    return <div className='editor-loading'>Loading…</div>
  if (data.error)
    return <div className='editor-error'>Failed to load: {data.error}</div>
  if (data.isBinary) {
    return <BinaryView filePath={activeFile} size={data.size} />
  }

  return <FileBody filePath={activeFile} data={data} workspace={workspace} />
}

/**
 * Binary files can't be edited as text. Images get an inline preview (served
 * straight from the download endpoint); everything else gets a download
 * affordance instead of a dead-end "not previewable" message.
 */
function BinaryView({ filePath, size }) {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  const isImage = IMAGE_EXTS.has(ext)
  const [imgUrl, setImgUrl] = useState(null)
  const [imgError, setImgError] = useState(null)

  useEffect(() => {
    if (!isImage) return
    let revoked = false
    let objectUrl = null
    setImgUrl(null)
    setImgError(null)
    entryBlobUrl(filePath)
      .then(url => {
        if (revoked) {
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setImgUrl(url)
      })
      .catch(err => setImgError(err.message))
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [filePath, isImage])

  return (
    <div className='editor-binary'>
      {isImage ? (
        imgError ? (
          <div className='editor-binary-icon' aria-hidden='true'>
            {'\u{26A0}\uFE0F'}
          </div>
        ) : imgUrl ? (
          <img
            className='editor-binary-img'
            src={imgUrl}
            alt={fileName(filePath)}
          />
        ) : (
          <div className='editor-loading'>Loading preview…</div>
        )
      ) : (
        <div className='editor-binary-icon' aria-hidden='true'>
          {'\u{1F4E6}'}
        </div>
      )}
      <div className='editor-binary-meta'>
        {fileName(filePath)} · {size.toLocaleString()} bytes
        {!isImage && ' · binary file'}
      </div>
      <button
        className='editor-binary-download'
        onClick={() =>
          downloadEntry(filePath).catch(e =>
            window.alert(e.message || 'Download failed'),
          )
        }
      >
        <DownloadIcon size={14} />
        Download
      </button>
    </div>
  )
}

function EmptyState() {
  return (
    <div className='editor-empty'>
      <div className='editor-empty-icon'>{'\u{1F4C2}'}</div>
      <div className='editor-empty-title'>No file open</div>
      <div className='editor-empty-hint'>
        Pick a file from the tree on the left to start editing.
      </div>
    </div>
  )
}

function FileBody({ filePath, data, workspace }) {
  const editable = !data.truncated && !data.isBinary
  // For editable files we render `draft` (which is seeded from `content`
  // on load). For truncated files we keep the read-only <pre> view.
  const text = editable ? (data.draft ?? '') : (data.content ?? '')

  const setDraft = useWorkspaceIdeStore(s => s.setDraft)
  const saveActiveFile = useWorkspaceIdeStore(s => s.saveActiveFile)

  const { gutter, charCount, lineCount } = useMemo(() => {
    const ls = text.split('\n')
    const lastEmpty = ls.length > 0 && ls[ls.length - 1] === ''
    return {
      gutter: Array.from({ length: ls.length }, (_, i) => i + 1).join('\n'),
      charCount: text.length,
      lineCount: lastEmpty ? ls.length - 1 : ls.length,
    }
  }, [text])

  const crumbs = useMemo(
    () => buildBreadcrumb(filePath, workspace),
    [filePath, workspace],
  )

  // Cmd/Ctrl+S to save the active editable file.
  useEffect(() => {
    if (!editable) return
    const handler = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveActiveFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editable, saveActiveFile])

  return (
    <div className='editor-body-wrap'>
      <Breadcrumb crumbs={crumbs} />
      <EditorBody
        filePath={filePath}
        text={text}
        gutter={gutter}
        editable={editable}
        onChangeDraft={v => setDraft(filePath, v)}
      />
      <StatusBar
        filePath={filePath}
        text={text}
        lineCount={lineCount}
        charCount={charCount}
        size={data.size}
        truncated={data.truncated}
        editable={editable}
        dirty={Boolean(data.dirty)}
        saveError={data.saveError}
        onSave={saveActiveFile}
      />
    </div>
  )
}

function EditorBody({ filePath, text, gutter, editable, onChangeDraft }) {
  const textareaRef = useRef(null)
  const gutterRef = useRef(null)

  // Keep the gutter scroll in sync with the textarea so line numbers
  // track the visible code.
  const handleScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  return (
    <div
      className={`editor-body ${editable ? 'editor-body--edit' : 'editor-body--readonly'}`}
    >
      <pre ref={gutterRef} className='editor-gutter' aria-hidden='true'>
        {gutter}
      </pre>
      {editable ? (
        <textarea
          ref={textareaRef}
          className='editor-code editor-code--edit'
          value={text}
          spellCheck={false}
          onChange={e => onChangeDraft(e.target.value)}
          onScroll={handleScroll}
          // Soft-tab: insert 2 spaces, don't escape the editor.
          onKeyDown={e => {
            if (e.key === 'Tab') {
              e.preventDefault()
              const ta = e.currentTarget
              const { selectionStart: s, selectionEnd: ee, value } = ta
              const next = value.slice(0, s) + '  ' + value.slice(ee)
              onChangeDraft(next)
              requestAnimationFrame(() => {
                ta.selectionStart = ta.selectionEnd = s + 2
              })
            }
          }}
          // Re-key by filePath so React doesn't reuse the same textarea
          // (and stale undo stack) across tabs.
          key={filePath}
        />
      ) : (
        <pre className='editor-code'>{text}</pre>
      )}
    </div>
  )
}

function Breadcrumb({ crumbs }) {
  return (
    <div className='editor-breadcrumb'>
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className='editor-breadcrumb-sep'>›</span>}
          <span
            className={`editor-breadcrumb-item ${i === crumbs.length - 1 ? 'leaf' : ''}`}
          >
            {c}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

function StatusBar({
  filePath,
  text,
  lineCount,
  charCount,
  size,
  truncated,
  editable,
  dirty,
  saveError,
  onSave,
}) {
  return (
    <div className='editor-statusbar'>
      <span>{lineCount.toLocaleString()} lines</span>
      <span>{charCount.toLocaleString()} chars</span>
      <span className='editor-statusbar-sep'>·</span>
      <span>{languageLabel(filePath)}</span>
      <span className='editor-statusbar-sep'>·</span>
      <span>UTF-8</span>
      {truncated && (
        <>
          <span className='editor-statusbar-sep'>·</span>
          <span className='editor-statusbar-warn'>
            truncated ({(size / 1024).toFixed(0)} KB total) — read-only
          </span>
        </>
      )}
      {saveError && (
        <>
          <span className='editor-statusbar-sep'>·</span>
          <span className='editor-statusbar-error' title={saveError}>
            save failed: {saveError}
          </span>
        </>
      )}
      <span className='editor-statusbar-spacer' />

      {editable ? (
        <>
          <span
            className={`editor-mode-pill ${dirty ? 'editor-mode-pill--dirty' : ''}`}
          >
            {dirty ? 'modified' : 'saved'}
          </span>
          <button
            className='editor-mode-btn'
            onClick={onSave}
            disabled={!dirty}
            title='Save (Cmd/Ctrl+S)'
          >
            Save
          </button>
          <CopyButton text={text} label='Copy' inline />
        </>
      ) : (
        <>
          <span className='editor-statusbar-lock'>
            <svg
              width='11'
              height='11'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <rect x='3' y='11' width='18' height='11' rx='2' />
              <path d='M7 11V7a5 5 0 0 1 10 0v4' />
            </svg>
            Read-only
          </span>
          <CopyButton text={text} label='Copy' inline />
        </>
      )}
    </div>
  )
}
