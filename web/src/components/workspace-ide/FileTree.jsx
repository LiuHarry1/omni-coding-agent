import { useCallback, useEffect, useRef, useState } from 'react'
import {
  downloadEntry,
  useWorkspaceIdeStore,
} from '../../stores/workspace-ide-store.js'
import { fileName } from '../../lib/utils.js'
import TreeContextMenu from './TreeContextMenu.jsx'
import {
  FolderIcon,
  FileIcon,
  NewFileIcon,
  NewFolderIcon,
  UploadIcon,
} from './icons.jsx'

/**
 * Lazy-loading recursive file tree. Each directory's entries are fetched
 * on first expand and cached in `dirCache`. Files are clickable; clicking
 * opens them in the editor tabs.
 *
 * Directories also expose hover actions (+File / +Folder) that trigger an
 * inline input row inside the directory. The actual filesystem write goes
 * through the store, which targets the bound environment's file API.
 */
const APP_CONFIG_DIR = '.ai-agent'

function isEnvDotEntry(name) {
  return name === '.env' || name.startsWith('.env.')
}

/** Dot entries shown without "show hidden files" — don't dim in the tree. */
function isHiddenTreeEntry(name) {
  if (name === APP_CONFIG_DIR || isEnvDotEntry(name)) return false
  return name.startsWith('.')
}

export default function FileTree({ rootPath }) {
  const expandDir = useWorkspaceIdeStore(s => s.expandDir)
  const deleteEntry = useWorkspaceIdeStore(s => s.deleteEntry)
  const [ctxMenu, setCtxMenu] = useState(null)

  useEffect(() => {
    if (rootPath) expandDir(rootPath)
  }, [rootPath, expandDir])

  const openContextMenu = useCallback((e, target) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, target })
  }, [])

  if (!rootPath) return <div className='file-tree-empty'>No workspace</div>

  return (
    <div className='file-tree'>
      <DirNode
        dirPath={rootPath}
        depth={0}
        isWorkspaceRoot
        onContextMenu={openContextMenu}
      />
      <TreeContextMenu
        menu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onDelete={t => deleteEntry(t)}
        onDownload={t =>
          downloadEntry(t.path).catch(e =>
            window.alert(e.message || 'Download failed'),
          )
        }
      />
    </div>
  )
}

function DirNode({ dirPath, depth, isWorkspaceRoot = false, onContextMenu }) {
  const data = useWorkspaceIdeStore(s => s.dirCache[dirPath])
  const isExpanded = useWorkspaceIdeStore(s => s.expandedDirs.has(dirPath))
  const toggleDir = useWorkspaceIdeStore(s => s.toggleDir)
  const beginCreate = useWorkspaceIdeStore(s => s.beginCreate)
  const pendingNew = useWorkspaceIdeStore(s => s.pendingNew)
  const uploadToDir = useWorkspaceIdeStore(s => s.uploadToDir)
  const upload = useWorkspaceIdeStore(s => s.uploadState[dirPath])

  const fileInputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const name = fileName(dirPath) || dirPath
  const showInlineRow = pendingNew && pendingNew.parentDir === dirPath
  const isHidden = isHiddenTreeEntry(name)

  const handleAction = kind => e => {
    e.stopPropagation()
    beginCreate(dirPath, kind)
  }

  const handleUploadClick = e => {
    e.stopPropagation()
    fileInputRef.current?.click()
  }

  const handleFilesPicked = e => {
    const { files } = e.target
    if (files && files.length) uploadToDir(dirPath, files)
    e.target.value = '' // allow re-selecting the same file
  }

  const handleDragOver = e => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    if (!dragOver) setDragOver(true)
  }

  const handleDragLeave = e => {
    e.stopPropagation()
    setDragOver(false)
  }

  const handleDrop = e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    uploadToDir(dirPath, e.dataTransfer.files)
  }

  return (
    <>
      <div
        className={`tree-row tree-dir ${dragOver ? 'tree-drop-target' : ''} ${isHidden ? 'tree-hidden-entry' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => toggleDir(dirPath)}
        onContextMenu={
          isWorkspaceRoot
            ? undefined
            : e => onContextMenu(e, { path: dirPath, name, isDir: true })
        }
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <svg
          className={`tree-chevron ${isExpanded ? 'open' : ''}`}
          width='10'
          height='10'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <polyline points='9 6 15 12 9 18' />
        </svg>
        <span className='tree-icon tree-icon--dir'>
          <FolderIcon open={isExpanded} />
        </span>
        <span className='tree-name'>{name}</span>
        <span className='tree-actions'>
          <button
            className='tree-action-btn'
            onClick={handleAction('file')}
            title='New file'
            tabIndex={-1}
          >
            <NewFileIcon size={12} />
          </button>
          <button
            className='tree-action-btn'
            onClick={handleAction('folder')}
            title='New folder'
            tabIndex={-1}
          >
            <NewFolderIcon size={12} />
          </button>
          <button
            className='tree-action-btn'
            onClick={handleUploadClick}
            title='Upload files here'
            tabIndex={-1}
          >
            <UploadIcon size={12} />
          </button>
        </span>
        <input
          ref={fileInputRef}
          type='file'
          multiple
          hidden
          onChange={handleFilesPicked}
        />
      </div>

      {isExpanded && showInlineRow && (
        <NewEntryRow
          depth={depth + 1}
          kind={pendingNew.kind}
          error={pendingNew.error}
        />
      )}

      {isExpanded && upload && (
        <UploadRow depth={depth + 1} dirPath={dirPath} upload={upload} />
      )}

      {isExpanded &&
        data &&
        (data.entries.length === 0 && !showInlineRow ? (
          isWorkspaceRoot ? (
            <div className='tree-root-empty'>
              <span className='tree-root-empty__icon' aria-hidden='true'>
                <FolderIcon open />
              </span>
              <strong>This workspace is empty</strong>
              <span>
                Create a file, add a folder, or upload an existing project.
              </span>
              <div className='tree-root-empty__actions'>
                <button type='button' onClick={handleAction('file')}>
                  <NewFileIcon size={13} />
                  New file
                </button>
                <button type='button' onClick={handleAction('folder')}>
                  <NewFolderIcon size={13} />
                  New folder
                </button>
                <button type='button' onClick={handleUploadClick}>
                  <UploadIcon size={13} />
                  Upload
                </button>
              </div>
            </div>
          ) : (
            <div
              className='tree-row tree-empty'
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              (empty)
            </div>
          )
        ) : (
          data.entries.map(entry =>
            entry.isDir ? (
              <DirNode
                key={entry.path}
                dirPath={entry.path}
                depth={depth + 1}
                onContextMenu={onContextMenu}
              />
            ) : (
              <FileRow
                key={entry.path}
                entry={entry}
                depth={depth + 1}
                onContextMenu={onContextMenu}
              />
            ),
          )
        ))}
      {isExpanded && !data && (
        <div
          className='tree-row tree-loading'
          style={{ paddingLeft: 8 + (depth + 1) * 14 }}
        >
          Loading…
        </div>
      )}
    </>
  )
}

function FileRow({ entry, depth, onContextMenu }) {
  const isActive = useWorkspaceIdeStore(s => s.activeFile === entry.path)
  const isDirty = useWorkspaceIdeStore(s =>
    Boolean(s.fileContents[entry.path]?.dirty),
  )
  const openFile = useWorkspaceIdeStore(s => s.openFile)
  const isHidden = isHiddenTreeEntry(entry.name)

  return (
    <div
      className={`tree-row tree-file ${isActive ? 'active' : ''} ${isHidden ? 'tree-hidden-entry' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 + 12 /* chevron gutter */ }}
      onClick={() => openFile(entry.path)}
      onContextMenu={e =>
        onContextMenu(e, { path: entry.path, name: entry.name, isDir: false })
      }
      title={entry.path}
    >
      <span className='tree-icon tree-icon--file'>
        <FileIcon />
      </span>
      <span className='tree-name'>
        {isDirty && (
          <span className='tree-dirty-dot' aria-hidden='true'>
            ●
          </span>
        )}
        {entry.name}
      </span>
    </div>
  )
}

/**
 * Inline upload-progress row, rendered inside a directory while an upload
 * is in flight. Mirrors NewEntryRow's placement so the tree feels coherent.
 */
function UploadRow({ depth, dirPath, upload }) {
  const dismissUpload = useWorkspaceIdeStore(s => s.dismissUpload)
  const { pct, error } = upload

  return (
    <div
      className={`tree-row tree-upload ${error ? 'tree-upload--error' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 + 12 }}
    >
      <span className='tree-icon tree-icon--file'>
        <UploadIcon size={12} />
      </span>
      {error ? (
        <>
          <span className='tree-upload-error' title={error}>
            {error}
          </span>
          <button
            className='tree-action-btn'
            onClick={() => dismissUpload(dirPath)}
            title='Dismiss'
          >
            ✕
          </button>
        </>
      ) : (
        <span className='tree-upload-bar' aria-label={`Uploading ${pct}%`}>
          <span className='tree-upload-fill' style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  )
}

/**
 * Inline editable row used for "New File" / "New Folder". The store owns
 * the validation + commit; this component is just an autofocused input
 * with Enter/Esc handlers.
 */
function NewEntryRow({ depth, kind, error }) {
  const commitCreate = useWorkspaceIdeStore(s => s.commitCreate)
  const cancelCreate = useWorkspaceIdeStore(s => s.cancelCreate)
  const inputRef = useRef(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    if (!value.trim()) {
      cancelCreate()
      return
    }
    commitCreate(value)
  }

  return (
    <div
      className={`tree-row tree-new ${error ? 'tree-new--error' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 + 12 }}
    >
      <span className='tree-icon tree-icon--file'>
        {kind === 'folder' ? <FolderIcon /> : <FileIcon />}
      </span>
      <input
        ref={inputRef}
        className='tree-new-input'
        value={value}
        placeholder={kind === 'folder' ? 'folder name' : 'file name'}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelCreate()
          }
        }}
        onBlur={() => {
          // Blur cancels; committing is Enter-only. Avoids surprise saves
          // when the user clicks elsewhere.
          if (!error) cancelCreate()
        }}
      />
      {error && (
        <span className='tree-new-error' title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
