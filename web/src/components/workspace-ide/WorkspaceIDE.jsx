import { useRef } from 'react'
import { useWorkspaceIdeStore } from '../../stores/workspace-ide-store.js'
import { fileName } from '../../lib/utils.js'
import FileTree from './FileTree.jsx'
import EditorTabs from './EditorTabs.jsx'
import EditorView from './EditorView.jsx'
import ResizeHandle from './ResizeHandle.jsx'
import ViewSwitcher from './ViewSwitcher.jsx'
import ChangesPanel from './ChangesPanel.jsx'
import { FolderIcon, NewFileIcon, NewFolderIcon, UploadIcon } from './icons.jsx'

/**
 * Left-side IDE panel. Header → 2-column body (file tree | editor). When
 * no file is open, the editor column is hidden and the tree fills the
 * whole panel — gives you full width to browse instead of staring at a
 * giant "No file open" placeholder.
 */
export default function WorkspaceIDE() {
  const open = useWorkspaceIdeStore(s => s.open)
  const width = useWorkspaceIdeStore(s => s.width)
  const setWidth = useWorkspaceIdeStore(s => s.setWidth)
  const treeWidth = useWorkspaceIdeStore(s => s.treeWidth)
  const setTreeWidth = useWorkspaceIdeStore(s => s.setTreeWidth)
  const toggle = useWorkspaceIdeStore(s => s.toggle)
  const refreshTree = useWorkspaceIdeStore(s => s.refreshTree)
  const collapseAll = useWorkspaceIdeStore(s => s.collapseAll)
  const showHiddenFiles = useWorkspaceIdeStore(s => s.showHiddenFiles)
  const toggleShowHiddenFiles = useWorkspaceIdeStore(
    s => s.toggleShowHiddenFiles,
  )
  const beginCreate = useWorkspaceIdeStore(s => s.beginCreate)
  const hasOpenFiles = useWorkspaceIdeStore(
    s => s.openFiles.length > 0 || s.openDiffs.length > 0,
  )
  const workspace = useWorkspaceIdeStore(s => s.rootPath)
  const activeView = useWorkspaceIdeStore(s => s.activeView)
  const uploadToDir = useWorkspaceIdeStore(s => s.uploadToDir)
  const uploadInputRef = useRef(null)

  if (!open) return null

  const normalizedWorkspace = workspace?.replace(/[\\/]+$/, '')
  const cwdLabel = normalizedWorkspace ? fileName(normalizedWorkspace) : null

  return (
    <aside className='workspace-ide' style={{ width }}>
      <div className='workspace-ide-header'>
        <div className='workspace-ide-title-group'>
          <span className='workspace-ide-title-icon' aria-hidden='true'>
            <FolderIcon size={15} />
          </span>
          <span className='workspace-ide-title-label'>Workspace</span>
          {cwdLabel && (
            <>
              <span className='workspace-ide-title-sep'>·</span>
              <span className='workspace-ide-title-cwd' title={workspace}>
                {cwdLabel}
              </span>
            </>
          )}
        </div>

        <div className='workspace-ide-actions'>
          <button
            className='icon-btn'
            onClick={() => workspace && beginCreate(workspace, 'file')}
            title='New file (in workspace root)'
            disabled={!workspace}
          >
            <NewFileIcon size={14} />
          </button>
          <button
            className='icon-btn'
            onClick={() => workspace && beginCreate(workspace, 'folder')}
            title='New folder (in workspace root)'
            disabled={!workspace}
          >
            <NewFolderIcon size={14} />
          </button>
          <button
            className='icon-btn'
            onClick={() => uploadInputRef.current?.click()}
            title='Upload files (to workspace root)'
            disabled={!workspace}
          >
            <UploadIcon size={14} />
          </button>
          <input
            ref={uploadInputRef}
            type='file'
            multiple
            hidden
            onChange={e => {
              if (workspace && e.target.files?.length) {
                uploadToDir(workspace, e.target.files)
              }
              e.target.value = ''
            }}
          />
          <button
            className={`icon-btn ${showHiddenFiles ? 'icon-btn--active' : ''}`}
            onClick={() => toggleShowHiddenFiles()}
            title={
              showHiddenFiles
                ? 'Hide hidden files'
                : 'Show hidden files (.git, …)'
            }
          >
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              {showHiddenFiles ? (
                <>
                  <path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' />
                  <path d='M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' />
                  <line x1='1' y1='1' x2='23' y2='23' />
                </>
              ) : (
                <>
                  <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' />
                  <circle cx='12' cy='12' r='3' />
                </>
              )}
            </svg>
          </button>
          <button
            className='icon-btn'
            onClick={refreshTree}
            title='Refresh tree'
          >
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <polyline points='23 4 23 10 17 10' />
              <polyline points='1 20 1 14 7 14' />
              <path d='M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' />
            </svg>
          </button>
          <button
            className='icon-btn'
            onClick={collapseAll}
            title='Collapse all'
          >
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <polyline points='4 14 10 14 10 20' />
              <polyline points='20 10 14 10 14 4' />
              <line x1='14' y1='10' x2='21' y2='3' />
              <line x1='3' y1='21' x2='10' y2='14' />
            </svg>
          </button>
          <button className='icon-btn' onClick={toggle} title='Close workspace'>
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <line x1='18' y1='6' x2='6' y2='18' />
              <line x1='6' y1='6' x2='18' y2='18' />
            </svg>
          </button>
        </div>
      </div>

      <div className={`workspace-ide-body ${hasOpenFiles ? '' : 'tree-only'}`}>
        <div
          className='workspace-ide-side'
          style={hasOpenFiles ? { width: treeWidth } : undefined}
        >
          <ViewSwitcher />
          <div className='workspace-ide-tree'>
            {activeView === 'explorer' ? (
              <FileTree rootPath={workspace} />
            ) : (
              <ChangesPanel />
            )}
          </div>
        </div>

        {hasOpenFiles && (
          <>
            <ResizeHandle
              mode='delta'
              className='workspace-ide-split-resize'
              getSize={() => treeWidth}
              onResize={setTreeWidth}
              onReset={() => setTreeWidth(260)}
            />
            <div className='workspace-ide-editor'>
              <EditorTabs />
              <EditorView />
            </div>
          </>
        )}
      </div>

      <ResizeHandle
        onResize={setWidth}
        onReset={() => setWidth(Math.round(window.innerWidth * 0.6))}
      />
    </aside>
  )
}
